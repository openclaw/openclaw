import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { removeRegistryEntry, updateRegistry } from "../agents/sandbox/registry.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import { assertConfiguredWorkspaceStateReady } from "../agents/workspace-state-dirs.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { AgentSandboxConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "./state-migrations.workspace-setup.js";

const SEEDED_AT = "2026-07-20T00:00:00.000Z";
const MARKER = "openclaw-workspace-state.json";

const sessionDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "openclaw-sandbox-workspace-migration-home-",
);
afterEach(() => vi.unstubAllEnvs());

function setup(
  sandbox: AgentSandboxConfig = {},
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = { main: {} },
  publish = true,
) {
  const homeDir = sessionDirs.make();
  const stateDir = path.join(homeDir, ".openclaw");
  const workspaceDir = path.join(homeDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const env = { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
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
  if (publish) {
    setRuntimeConfigSnapshot(cfg);
  }
  return {
    homeDir,
    stateDir,
    env,
    cfg,
    marker(
      rawSessionKey: string,
      workspaceRoot = path.join(homeDir, "sandboxes"),
      scope: AgentSandboxConfig["scope"] = "session",
    ) {
      const agentId = parseAgentSessionKey(rawSessionKey)?.agentId ?? "main";
      return path.join(
        resolveSandboxWorkspaceLayoutPaths({
          cfg: { scope, workspaceAccess: "ro", workspaceRoot },
          agentId,
          rawSessionKey,
          workspaceDir: resolveAgentWorkspaceDir(cfg, agentId, env),
        }).sandboxWorkspaceDir,
        MARKER,
      );
    },
  };
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
  { cfg, env, stateDir, homeDir }: ReturnType<typeof setup>,
  active: string,
  protectedPaths: string[] = [],
) {
  const options = { cfg, stateDir, env };
  const detected = await detectLegacyWorkspaceState({
    ...options,
    homedir: () => homeDir,
    doctorOnlyStateMigrations: true,
  });
  expect(detected.sources.map((source) => source.sourcePath)).toEqual([active]);
  const result = await migrateLegacyWorkspaceState({ detected, ...options });
  expect(result.warnings).toEqual([]);
  expect(fs.existsSync(active)).toBe(false);
  for (const file of protectedPaths) {
    expect(fs.existsSync(file)).toBe(true);
  }
  expect(await readWorkspaceStateSnapshot(path.dirname(active), { env })).toMatchObject({
    setup: { bootstrapSeededAt: SEEDED_AT },
    setupExists: true,
  });
}

it.each(["discovered workspace", "read failure"] as const)(
  "awaits persisted session keys before reporting readiness: %s",
  async (outcome) => {
    const context = setup();
    const { cfg } = context;
    const sessionKey = "agent:main:telegram:direct:delayed-discovery";
    const legacyPath = context.marker(sessionKey);
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
    const settled = vi.fn();
    const readiness = assertConfiguredWorkspaceStateReady({ cfg, env: context.env });
    void readiness.then(settled, settled);
    try {
      await withTestTimeout(entered.promise, 5_000, "Session-key discovery was not reached");
      expect(settled).not.toHaveBeenCalled();
      await register(sessionKey);
      writeMarkers(legacyPath);
      release.resolve();
      if (outcome === "read failure") {
        await expect(readiness).rejects.toBe(unavailable);
      } else {
        await expect(readiness).rejects.toThrow("Legacy workspace setup state requires migration");
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

it("repairs only durable sandboxed sessions after pruning, excluding main sessions in non-main mode", async () => {
  const context = setup(
    {},
    {
      main: { sandbox: { mode: "off" } },
      "main-telegram": { sandbox: { mode: "non-main" } },
      writer: { sandbox: { workspaceAccess: "rw" } },
    },
  );
  const activeSession = "agent:main-telegram:signal:direct:doctor-proof";
  const inactiveSessions = [
    "agent:main:telegram:direct:doctor-proof",
    "agent:main-telegram:main",
    "agent:writer:telegram:direct:doctor-proof",
  ];
  const active = context.marker(activeSession);
  const protectedPaths = [
    ...inactiveSessions,
    "agent:removed:telegram:direct:doctor-proof",
    "agent:main",
    "shared",
  ].map((session) => context.marker(session));
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
  await repair(context, active, protectedPaths);
});

it("takes both durable ownership and the default sandbox root from the requested profile", async () => {
  const context = setup({ workspaceRoot: undefined });
  const requestedStateDir = path.join(context.homeDir, "requested-profile");
  const requested = {
    ...context,
    stateDir: requestedStateDir,
    env: { ...context.env, OPENCLAW_STATE_DIR: requestedStateDir },
  };
  const requestedSession = "agent:main:telegram:direct:requested-profile";
  const ambientSession = "agent:main:slack:direct:ambient-profile";
  const requestedRoot = path.join(requestedStateDir, "sandboxes");
  const active = context.marker(requestedSession, requestedRoot);
  const protectedPaths = [
    context.marker(ambientSession, requestedRoot),
    context.marker(requestedSession, path.join(context.stateDir, "sandboxes")),
  ];
  writeMarkers(active, ...protectedPaths);
  await register(requestedSession, requested.env);
  await register(ambientSession, context.env);
  for (const [env, session] of [
    [requested.env, requestedSession],
    [context.env, ambientSession],
  ] as const) {
    expect(await sessionAccessor.listSessionEntryKeysReadOnly({ agentId: "main", env })).toEqual([
      session,
    ]);
  }
  await repair(requested, active, protectedPaths);
});

it("repairs sandbox workspace copies beneath the configured OpenClaw home", async () => {
  const context = setup({ scope: "agent" }, undefined, false);
  const effectiveHome = path.join(context.homeDir, "effective-openclaw-home");
  vi.stubEnv("OPENCLAW_HOME", effectiveHome);
  const env = {
    ...context.env,
    OPENCLAW_HOME: effectiveHome,
    OPENCLAW_CONFIG_PATH: path.join(context.stateDir, "openclaw.json"),
  };
  setRuntimeConfigSnapshot(context.cfg);
  const active = context.marker("agent:main:main", path.join(effectiveHome, "sandboxes"), "agent");
  writeMarkers(active);
  await repair({ ...context, env }, active);
});
