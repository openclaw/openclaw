import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import {
  resolveSessionKeyFromResolveParams as resolveSessionKeyFromResolveParamsWithClient,
  withPreparedSessionResolve,
} from "./sessions-resolve.js";

type ResolveParams = Parameters<typeof resolveSessionKeyFromResolveParamsWithClient>[0];
const mainWork = (): OpenClawConfig => ({ agents: { entries: { main: {}, work: {} } } });
const opsOnly = (): OpenClawConfig => ({ agents: { entries: { ops: {} } } });
const resolved = (key: string, agentId = "main") => ({ ok: true, key, agentId });

const projections = new Map<OpenClawConfig, Promise<SessionRowProjection>>();
const resolve = async (cfg: OpenClawConfig, p: ResolveParams["p"]) => {
  let pending = projections.get(cfg);
  if (!pending) {
    pending = createSessionRowProjection({ cfg });
    projections.set(cfg, pending);
  }
  return withPreparedSessionResolve(
    { client: null, p, projection: await pending },
    (result) => result,
  );
};

describe("resolveSessionKeyFromResolveParams store canonicalization", () => {
  const deletedMainError = 'Agent "main" no longer exists in configuration';
  const expectInvalid = (cfg: OpenClawConfig, p: ResolveParams["p"], message: string) =>
    expect(resolve(cfg, p)).resolves.toEqual({
      ok: false,
      error: { code: ErrorCodes.INVALID_REQUEST, message },
    });

  async function withStateDirEnv<T>(
    prefix: string,
    fn: (ctx: { tempRoot: string; stateDir: string }) => Promise<T>,
  ): Promise<T> {
    return withRawStateDirEnv(prefix, async (ctx) => {
      try {
        return await fn(ctx);
      } finally {
        for (const pending of projections.values()) {
          (await pending).dispose();
        }
        projections.clear();
      }
    });
  }

  async function seedSessionStore(
    storePath: string,
    store: Record<string, SessionEntry>,
  ): Promise<void> {
    for (const [sessionKey, entry] of Object.entries(store)) {
      await replaceSessionEntry({ storePath, sessionKey }, entry);
    }
  }

  const seedAgent = (cfg: OpenClawConfig, agentId: string, store: Record<string, SessionEntry>) =>
    seedSessionStore(resolveSessionStorePathCore(cfg.session?.store, { agentId }), store);
  const entry = (sessionId: string, label?: string): SessionEntry => ({
    sessionId,
    label,
    updatedAt: Date.now(),
  });

  it("does not resolve another agent store when agentId is scoped", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-agent-scope-", async () => {
      const cfg = mainWork();
      await seedAgent(cfg, "work", {
        "agent:work:target": entry("sess-shared", "shared-label"),
      });
      await expectInvalid(
        cfg,
        { sessionId: "sess-shared", agentId: "main" },
        "No session found: sess-shared",
      );
      await expectInvalid(
        cfg,
        { label: "shared-label", agentId: "main" },
        "No session found with label: shared-label",
      );
    });
  });

  it("rejects an exact bare key scoped to a different fixed-store owner", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-owner-conflict-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "shared-sessions.sqlite");
      const cfg = {
        session: { store: storePath, scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      } satisfies OpenClawConfig;
      await seedSessionStore(storePath, {
        global: entry("sess-owned-global"),
      });

      await expect(resolve(cfg, { key: "global", agentId: "research" })).resolves.toMatchObject({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'agent "research" does not match session key agent "ops"',
        },
      });
    });
  });

  it("preserves cross-agent ambiguity when agentId is absent", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-cross-agent-", async () => {
      const cfg = mainWork();
      const shared = entry("sess-shared", "shared-label");
      await seedAgent(cfg, "main", { "main-target": shared });
      await seedAgent(cfg, "work", { "work-target": shared });

      for (const [selector, message] of [
        [{ sessionId: "sess-shared" }, "Multiple sessions found for sessionId: sess-shared"],
        [{ label: "shared-label" }, "Multiple sessions found with label: shared-label"],
      ] as const) {
        const result = await resolve(cfg, selector);
        expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.INVALID_REQUEST } });
        if (result.ok) {
          throw new Error("expected ambiguous result");
        }
        expect(result.error.message).toContain(message);
        expect(result.error.message).toContain("agent:main:main-target");
        expect(result.error.message).toContain("agent:work:work-target");
      }
    });
  });

  it("resolves duplicate bare global rows with the selected row owner", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-global-owner-", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      };
      await seedAgent(cfg, "ops", { global: entry("session-ops") });
      await seedAgent(cfg, "research", { global: entry("session-research") });

      await expect(
        resolve(cfg, { sessionId: "session-research", includeGlobal: true }),
      ).resolves.toEqual(resolved("global", "research"));
    });
  });

  it("selects the deterministic winner within one agent before cross-agent checks", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-same-agent-", async () => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      await seedAgent(cfg, "main", {
        "agent:main:older": { sessionId: "session-duplicate", updatedAt: 10 },
        "agent:main:newer": { sessionId: "session-duplicate", updatedAt: 20 },
      });

      await expect(resolve(cfg, { sessionId: "session-duplicate" })).resolves.toEqual(
        resolved("agent:main:newer"),
      );
    });
  });

  it("still rejects non-alias agent:main matches when main is no longer configured", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-stale-main-", async () => {
      const cfg = {
        session: { mainKey: "main", store: undefined },
        agents: { entries: { ops: {} } },
      } satisfies OpenClawConfig;
      await seedAgent(cfg, "main", {
        "agent:main:guildchat:direct:u1": entry("sess-stale-main", "stale-main"),
      });
      await expectInvalid(cfg, { sessionId: "sess-stale-main" }, deletedMainError);
    });
  });

  it("does not adopt legacy main aliases from discovered deleted-agent stores", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-discovered-main-", async () => {
      const cfg = opsOnly();
      await seedAgent(cfg, "main", {
        "agent:main:main": entry("sess-discovered-main", "discovered-main"),
      });
      await expectInvalid(cfg, { sessionId: "sess-discovered-main" }, deletedMainError);
      await expectInvalid(cfg, { label: "discovered-main" }, deletedMainError);
    });
  });

  it.each([
    {
      name: "ordinary reads leave lifecycle-bound legacy ACP metadata unavailable",
      repair: false,
    },
    { name: "Doctor repairs ACP keys after session rows are canonical", repair: true },
  ])("$name", async ({ repair }) => {
    await withStateDirEnv(
      "openclaw-sessions-resolve-acp-harness-partial-",
      async ({ tempRoot, stateDir }) => {
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} } },
          plugins: { enabled: false },
        };
        const acpKey = "agent:claude:acp:44444444-4444-4444-8444-444444444444";
        const legacyAcpKey = "agent:CLAUDE:acp:44444444-4444-4444-8444-444444444444";
        const claudeStorePath = resolveSessionStorePathCore(cfg.session?.store, {
          agentId: "claude",
        });
        await seedSessionStore(claudeStorePath, {
          [acpKey]: {
            sessionId: "sess-acp-harness-partial",
            lifecycleRevision: "revision-acp-harness-partial",
            label: "claude-delegate-partial",
            updatedAt: Date.now(),
          },
        });
        writeAcpSessionMetaForMigration({
          sessionKey: legacyAcpKey,
          lifecycleRevision: "revision-acp-harness-partial",
          meta: {
            backend: "acpx",
            agent: "claude",
            runtimeSessionName: legacyAcpKey,
            mode: "oneshot",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        });
        const readRows = () =>
          openOpenClawStateDatabase()
            .db.prepare("SELECT * FROM acp_sessions ORDER BY session_key")
            .all();
        const before = readRows();
        expect(before).toMatchObject([{ session_key: legacyAcpKey }]);

        if (repair) {
          await expect(fs.access(claudeStorePath)).rejects.toMatchObject({ code: "ENOENT" });
          await withEnvAsync(
            {
              HOME: tempRoot,
              USERPROFILE: tempRoot,
              OPENCLAW_HOME: tempRoot,
              OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            },
            async () => {
              const { noteSessionTranscriptHealth } =
                await import("../commands/doctor-session-transcripts.js");
              await noteSessionTranscriptHealth({ cfg, env: process.env, shouldRepair: false });
              expect(readRows()).toEqual(before);
              await noteSessionTranscriptHealth({ cfg, env: process.env, shouldRepair: true });
              const repaired = readRows();
              expect(repaired).toEqual([
                {
                  ...before[0],
                  session_key: buildAcpDatabaseSessionKey(acpKey, "claude"),
                },
              ]);
              await noteSessionTranscriptHealth({ cfg, env: process.env, shouldRepair: true });
              expect(readRows()).toEqual(repaired);
            },
          );
        }

        for (const selector of [
          { key: acpKey },
          { sessionId: "sess-acp-harness-partial" },
          { label: "claude-delegate-partial" },
        ]) {
          await expect(resolve(cfg, selector)).resolves.toEqual(
            repair
              ? resolved(acpKey, "claude")
              : {
                  ok: false,
                  error: {
                    code: ErrorCodes.INVALID_REQUEST,
                    message: 'Agent "claude" no longer exists in configuration',
                  },
                },
          );
          if (!repair) {
            expect(readRows()).toEqual(before);
          }
        }
      },
    );
  });

  it("rejects an explicit listed deleted main key instead of remapping to the live default main", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-key-deleted-main-", async () => {
      const cfg = opsOnly();
      await seedAgent(cfg, "ops", {
        "agent:ops:main": entry("sess-live-default"),
      });
      await seedAgent(cfg, "main", {
        "agent:main:main": entry("sess-deleted-main"),
      });
      await expectInvalid(cfg, { key: "agent:main:main" }, deletedMainError);
    });
  });
});
