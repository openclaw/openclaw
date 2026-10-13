/**
 * Session resolve store tests.
 */
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

const projections = new Map<OpenClawConfig, Promise<SessionRowProjection>>();
const resolveSessionKeyFromResolveParams = async (
  params: Omit<ResolveParams, "client" | "projection"> & {
    cfg: OpenClawConfig;
    client?: ResolveParams["client"];
  },
) => {
  let pending = projections.get(params.cfg);
  if (!pending) {
    pending = createSessionRowProjection({ cfg: params.cfg });
    projections.set(params.cfg, pending);
  }
  return withPreparedSessionResolve(
    {
      client: params.client ?? null,
      p: params.p,
      projection: await pending,
    },
    (result) => result,
  );
};

describe("resolveSessionKeyFromResolveParams store canonicalization", () => {
  const freshUpdatedAt = () => Date.now();

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

  it("does not resolve another agent store when agentId is scoped", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-agent-scope-", async () => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {}, work: {} } },
      };
      const workStorePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "work" });
      await seedSessionStore(workStorePath, {
        "agent:work:target": {
          sessionId: "sess-shared",
          label: "shared-label",
          updatedAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-shared", agentId: "main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: "No session found: sess-shared",
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { label: "shared-label", agentId: "main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: "No session found with label: shared-label",
        },
      });
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
        global: { sessionId: "sess-owned-global", updatedAt: freshUpdatedAt() },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { key: "global", agentId: "research" },
        }),
      ).resolves.toMatchObject({
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
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {}, work: {} } },
      };
      const updatedAt = freshUpdatedAt();
      await seedSessionStore(resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }), {
        "main-target": {
          sessionId: "sess-shared",
          label: "shared-label",
          updatedAt,
        },
      });
      await seedSessionStore(resolveSessionStorePathCore(cfg.session?.store, { agentId: "work" }), {
        "work-target": {
          sessionId: "sess-shared",
          label: "shared-label",
          updatedAt,
        },
      });

      const sessionIdResult = await resolveSessionKeyFromResolveParams({
        cfg,
        p: { sessionId: "sess-shared" },
      });
      expect(sessionIdResult.ok).toBe(false);
      if (sessionIdResult.ok) {
        throw new Error("expected ambiguous sessionId result");
      }
      expect(sessionIdResult.error.code).toBe(ErrorCodes.INVALID_REQUEST);
      expect(sessionIdResult.error.message).toContain(
        "Multiple sessions found for sessionId: sess-shared",
      );
      expect(sessionIdResult.error.message).toContain("agent:main:main-target");
      expect(sessionIdResult.error.message).toContain("agent:work:work-target");

      const labelResult = await resolveSessionKeyFromResolveParams({
        cfg,
        p: { label: "shared-label" },
      });
      expect(labelResult.ok).toBe(false);
      if (labelResult.ok) {
        throw new Error("expected ambiguous label result");
      }
      expect(labelResult.error.code).toBe(ErrorCodes.INVALID_REQUEST);
      expect(labelResult.error.message).toContain(
        "Multiple sessions found with label: shared-label",
      );
      expect(labelResult.error.message).toContain("agent:main:main-target");
      expect(labelResult.error.message).toContain("agent:work:work-target");
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
      await seedSessionStore(resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" }), {
        global: { sessionId: "session-ops", updatedAt: freshUpdatedAt() },
      });
      await seedSessionStore(
        resolveSessionStorePathCore(cfg.session?.store, { agentId: "research" }),
        {
          global: { sessionId: "session-research", updatedAt: freshUpdatedAt() },
        },
      );

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "session-research", includeGlobal: true },
        }),
      ).resolves.toEqual({ ok: true, key: "global", agentId: "research" });
    });
  });

  it("selects the deterministic winner within one agent before cross-agent checks", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-same-agent-", async () => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
      await seedSessionStore(storePath, {
        "agent:main:older": { sessionId: "session-duplicate", updatedAt: 10 },
        "agent:main:newer": { sessionId: "session-duplicate", updatedAt: 20 },
      });

      await expect(
        resolveSessionKeyFromResolveParams({ cfg, p: { sessionId: "session-duplicate" } }),
      ).resolves.toEqual({ ok: true, key: "agent:main:newer", agentId: "main" });
    });
  });

  it("still rejects non-alias agent:main matches when main is no longer configured", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-stale-main-", async () => {
      const cfg = {
        session: { mainKey: "main", store: undefined },
        agents: { entries: { ops: {} } },
      } satisfies OpenClawConfig;
      await seedSessionStore(resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }), {
        "agent:main:guildchat:direct:u1": {
          sessionId: "sess-stale-main",
          label: "stale-main",
          updatedAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-stale-main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'Agent "main" no longer exists in configuration',
        },
      });
    });
  });

  it("does not adopt legacy main aliases from discovered deleted-agent stores", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-discovered-main-", async () => {
      const cfg: OpenClawConfig = {
        agents: { entries: { ops: {} } },
      };
      const staleMainStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "main",
      });
      await seedSessionStore(staleMainStorePath, {
        "agent:main:main": {
          sessionId: "sess-discovered-main",
          label: "discovered-main",
          updatedAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-discovered-main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'Agent "main" no longer exists in configuration',
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { label: "discovered-main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'Agent "main" no longer exists in configuration',
        },
      });
    });
  });

  it.each([
    {
      name: "ordinary reads leave lifecycle-bound legacy ACP metadata unavailable",
      bound: true,
      repair: false,
    },
    { name: "Doctor repairs ACP keys after session rows are canonical", bound: true, repair: true },
  ])("$name", async ({ bound, repair }) => {
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
            updatedAt: freshUpdatedAt(),
          },
        });
        writeAcpSessionMetaForMigration({
          sessionKey: legacyAcpKey,
          lifecycleRevision: bound ? "revision-acp-harness-partial" : undefined,
          meta: {
            backend: "acpx",
            agent: "claude",
            runtimeSessionName: legacyAcpKey,
            mode: "oneshot",
            state: "idle",
            lastActivityAt: freshUpdatedAt(),
          },
        });
        const readRows = () =>
          openOpenClawStateDatabase()
            .db.prepare("SELECT * FROM acp_sessions ORDER BY session_key")
            .all();
        const before = readRows();
        expect(before).toHaveLength(1);
        expect(before[0]?.session_key).toBe(legacyAcpKey);

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
              expect(repaired).toHaveLength(1);
              expect(repaired[0]).toEqual({
                ...before[0],
                session_key: buildAcpDatabaseSessionKey(acpKey, "claude"),
              });
              await noteSessionTranscriptHealth({ cfg, env: process.env, shouldRepair: true });
              expect(readRows()).toEqual(repaired);
            },
          );
        }

        for (const selector of [
          { key: acpKey },
          { sessionId: "sess-acp-harness-partial" },
          { label: "claude-delegate-partial" },
          { key: acpKey },
        ]) {
          await expect(resolveSessionKeyFromResolveParams({ cfg, p: selector })).resolves.toEqual(
            repair
              ? { ok: true, key: acpKey, agentId: "claude" }
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
      const cfg: OpenClawConfig = {
        agents: { entries: { ops: {} } },
      };
      const liveDefaultStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "ops",
      });
      await seedSessionStore(liveDefaultStorePath, {
        "agent:ops:main": {
          sessionId: "sess-live-default",
          updatedAt: freshUpdatedAt(),
        },
      });
      const staleMainStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: "main",
      });
      await seedSessionStore(staleMainStorePath, {
        "agent:main:main": {
          sessionId: "sess-deleted-main",
          updatedAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { key: "agent:main:main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'Agent "main" no longer exists in configuration',
        },
      });
    });
  });
});
