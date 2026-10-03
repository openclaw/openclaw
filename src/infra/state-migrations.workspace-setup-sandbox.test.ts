import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { removeRegistryEntry, updateRegistry } from "../agents/sandbox/registry.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import { assertConfiguredWorkspaceStateReady } from "../agents/workspace-state-dirs.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { AgentSandboxConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "./state-migrations.workspace-setup.js";

const SEEDED_AT = "2026-07-20T00:00:00.000Z";
const MARKER = "openclaw-workspace-state.json";

describe("sandbox workspace Doctor migration", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  const sessionDirs = useSessionStoreTempDirs(
    afterAll,
    "openclaw-sandbox-workspace-migration-home-",
  );
  afterEach(() => {
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  function setup() {
    const homeDir = sessionDirs.make();
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(homeDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    return {
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
      homeDir,
      stateDir,
      workspaceDir,
    };
  }

  function config(
    context: ReturnType<typeof setup>,
    sandbox: AgentSandboxConfig = {},
    entries: NonNullable<OpenClawConfig["agents"]>["entries"] = { main: { default: true } },
  ): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: context.workspaceDir,
          sandbox: {
            mode: "all",
            scope: "session",
            workspaceAccess: "ro",
            workspaceRoot: "~/sandboxes",
            ...sandbox,
          },
        },
        entries,
      },
    };
  }

  function marker(
    context: ReturnType<typeof setup>,
    cfg: OpenClawConfig,
    rawSessionKey: string,
    workspaceRoot = path.join(context.homeDir, "sandboxes"),
    scope: AgentSandboxConfig["scope"] = "session",
  ) {
    const agentId = parseAgentSessionKey(rawSessionKey)?.agentId ?? "main";
    return path.join(
      resolveSandboxWorkspaceLayoutPaths({
        cfg: { scope, workspaceAccess: "ro", workspaceRoot },
        agentId,
        rawSessionKey,
        workspaceDir: resolveAgentWorkspaceDir(cfg, agentId, context.env),
      }).sandboxWorkspaceDir,
      MARKER,
    );
  }

  function writeMarkers(...files: string[]) {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, bootstrapSeededAt: SEEDED_AT }));
    }
  }

  async function register(sessionKey: string, env = process.env) {
    await sessionAccessor.upsertSessionEntryCore(
      { agentId: parseAgentSessionKey(sessionKey)?.agentId ?? "main", env, sessionKey },
      { sessionId: createHash("sha256").update(sessionKey).digest("hex"), updatedAt: 1 },
    );
  }

  async function repair(
    context: ReturnType<typeof setup>,
    cfg: OpenClawConfig,
    active: string,
    protectedPaths: string[] = [],
  ) {
    const detected = await detectLegacyWorkspaceState({
      cfg,
      stateDir: context.stateDir,
      env: context.env,
      homedir: () => context.homeDir,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.sources.map((source) => source.sourcePath)).toEqual([active]);
    const result = await migrateLegacyWorkspaceState({
      detected,
      env: context.env,
      stateDir: context.stateDir,
    });
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(active)).toBe(false);
    for (const file of protectedPaths) {
      expect(fs.existsSync(file)).toBe(true);
    }
    expect(
      await readWorkspaceStateSnapshot(path.dirname(active), { env: context.env }),
    ).toMatchObject({
      setup: { bootstrapSeededAt: SEEDED_AT },
      setupExists: true,
    });
  }

  it.each(["discovered workspace", "read failure"] as const)(
    "awaits persisted session keys before reporting readiness: %s",
    async (outcome) => {
      const context = setup();
      const cfg = config(context);
      const sessionKey = "agent:main:telegram:direct:delayed-discovery";
      const legacyPath = marker(context, cfg, sessionKey);
      const entered = createDeferred();
      const release = createDeferred();
      const unavailable = new Error("Session key storage is unavailable");
      const readKeys = sessionAccessor.listSessionEntryKeysReadOnly;
      const read = vi
        .spyOn(sessionAccessor, "listSessionEntryKeysReadOnly")
        .mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          if (outcome === "read failure") {
            throw unavailable;
          }
          return readKeys(...args);
        });
      let settled = false;
      const readiness = assertConfiguredWorkspaceStateReady({ cfg, env: context.env });
      void readiness.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await withTestTimeout(entered.promise, 5_000, "Session-key discovery was not reached");
        expect(settled).toBe(false);
        await register(sessionKey);
        writeMarkers(legacyPath);
        release.resolve();
        if (outcome === "read failure") {
          await expect(readiness).rejects.toBe(unavailable);
        } else {
          await expect(readiness).rejects.toThrow(
            "Legacy workspace setup state requires migration",
          );
        }
        expect(fs.existsSync(legacyPath)).toBe(true);
        expect(await readKeys({ agentId: "main", env: context.env })).toEqual([sessionKey]);
      } finally {
        release.resolve();
        await Promise.allSettled([readiness]);
        read.mockRestore();
      }
    },
  );

  it("repairs only durable session owners, including overlapping agent names after runtime pruning", async () => {
    const context = setup();
    const cfg = config(
      context,
      {},
      {
        main: { default: true, sandbox: { mode: "off" } },
        "main-telegram": {},
        writer: { sandbox: { workspaceAccess: "rw" } },
      },
    );
    const activeSession = "agent:main-telegram:signal:direct:doctor-proof";
    const inactiveSessions = [
      "agent:main:telegram:direct:doctor-proof",
      "agent:writer:telegram:direct:doctor-proof",
    ];
    const active = marker(context, cfg, activeSession);
    const protectedPaths = [
      ...inactiveSessions,
      "agent:removed:telegram:direct:doctor-proof",
      "agent:main",
      "shared",
    ].map((session) => marker(context, cfg, session));
    protectedPaths.push(path.join(context.homeDir, "sandboxes", "notes", MARKER));
    writeMarkers(active, ...protectedPaths);
    for (const session of [activeSession, ...inactiveSessions]) {
      await register(session);
    }
    for (const sessionKey of [activeSession, "agent:main", "shared"]) {
      await updateRegistry({
        containerName: sessionKey,
        sessionKey,
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox:test",
      });
    }
    await removeRegistryEntry(activeSession);
    await repair(context, cfg, active, protectedPaths);
  });

  it("takes both durable ownership and the default sandbox root from the requested profile", async () => {
    const context = setup();
    const requestedStateDir = path.join(context.homeDir, "requested-profile");
    const requested = {
      ...context,
      stateDir: requestedStateDir,
      env: { ...context.env, OPENCLAW_STATE_DIR: requestedStateDir },
    };
    const cfg = config(context, { workspaceRoot: undefined });
    const requestedSession = "agent:main:telegram:direct:requested-profile";
    const ambientSession = "agent:main:slack:direct:ambient-profile";
    const requestedRoot = path.join(requestedStateDir, "sandboxes");
    const active = marker(context, cfg, requestedSession, requestedRoot);
    const protectedPaths = [
      marker(context, cfg, ambientSession, requestedRoot),
      marker(context, cfg, requestedSession, path.join(context.stateDir, "sandboxes")),
    ];
    writeMarkers(active, ...protectedPaths);
    await register(requestedSession, requested.env);
    await register(ambientSession, context.env);
    expect(
      await sessionAccessor.listSessionEntryKeysReadOnly({ agentId: "main", env: requested.env }),
    ).toEqual([requestedSession]);
    expect(
      await sessionAccessor.listSessionEntryKeysReadOnly({ agentId: "main", env: context.env }),
    ).toEqual([ambientSession]);
    await repair(requested, cfg, active, protectedPaths);
  });

  it("does not migrate a main-session copy when sandbox mode is non-main", async () => {
    const context = setup();
    const cfg = config(context, { mode: "non-main" });
    const mainSession = "agent:main:main";
    const session = "agent:main:telegram:direct:doctor-proof";
    const active = marker(context, cfg, session);
    const main = marker(context, cfg, mainSession);
    writeMarkers(active, main);
    await register(mainSession);
    await register(session);
    await repair(context, cfg, active, [main]);
  });

  it("repairs sandbox workspace copies beneath the configured OpenClaw home", async () => {
    const context = setup();
    const effectiveHome = path.join(context.homeDir, "effective-openclaw-home");
    setTestEnvValue("OPENCLAW_HOME", effectiveHome);
    const env = {
      ...context.env,
      OPENCLAW_HOME: effectiveHome,
      OPENCLAW_CONFIG_PATH: path.join(context.stateDir, "openclaw.json"),
    };
    const cfg = config(context, { scope: "agent" });
    const active = marker(
      context,
      cfg,
      "agent:main:main",
      path.join(effectiveHome, "sandboxes"),
      "agent",
    );
    writeMarkers(active);
    await repair({ ...context, env }, cfg, active);
  });
});
