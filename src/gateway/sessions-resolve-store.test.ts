import { describe, expect, it } from "vitest";
import { upsertSessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { ErrorCodes } from "./protocol/index.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

describe("resolveSessionKeyFromResolveParams store canonicalization", () => {
  const freshUpdatedAt = () => Date.now();

  it("resolves legacy main-alias matches by sessionId and label for the configured default agent", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-alias-", async () => {
      const cfg = {
        session: { mainKey: "main" },
        agents: { list: [{ id: "ops", default: true }] },
      } satisfies OpenClawConfig;
      upsertSessionEntry({
        agentId: "ops",
        sessionKey: "agent:main:main",
        entry: {
          sessionId: "sess-default-alias",
          label: "default-alias",
          updatedAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-default-alias" },
        }),
      ).resolves.toEqual({ ok: true, key: "agent:ops:main" });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { label: "default-alias" },
        }),
      ).resolves.toEqual({ ok: true, key: "agent:ops:main" });
    });
  });

  it("still rejects non-alias agent:main matches when main is no longer configured", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-stale-main-", async () => {
      const cfg = {
        session: { mainKey: "main" },
        agents: { list: [{ id: "ops", default: true }] },
      } satisfies OpenClawConfig;
      upsertSessionEntry({
        agentId: "ops",
        sessionKey: "agent:main:guildchat:direct:u1",
        entry: {
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
        agents: { list: [{ id: "ops", default: true }] },
      };
      upsertSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        entry: {
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

  it("rejects an explicit listed deleted main key instead of remapping to the live default main", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-key-deleted-main-", async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
      };
      upsertSessionEntry({
        agentId: "ops",
        sessionKey: "agent:ops:main",
        entry: {
          sessionId: "sess-live-default",
          updatedAt: freshUpdatedAt(),
        },
      });
      upsertSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        entry: {
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
