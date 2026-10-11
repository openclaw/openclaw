import path from "node:path";
import { describe, expect, test } from "vitest";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import {
  prepareDeletedAgentSessionCheck,
  resolveDeletedAgentIdFromSessionKey,
} from "./session-utils-store.js";
import { seedSessionEntries, withStateDirEnv } from "./session-utils.test-support.js";

describe("gateway deleted-agent session checks", () => {
  test("resolveDeletedAgentIdFromSessionKey rejects non-alias main keys when main is absent", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { entries: { ops: {} } },
    } as OpenClawConfig;
    const legacyMainAlias = resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" });

    expect(legacyMainAlias).toBe("agent:ops:work");
    expect(resolveDeletedAgentIdFromSessionKey(cfg, legacyMainAlias)).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "global")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "unknown")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "main")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "agent:main:discord:direct:u1")).toBe("main");
  });

  test("deleted-agent checks require canonical ACP metadata instead of embedded entries", async () => {
    await withStateDirEnv("session-utils-acp-canonical-facts-", async () => {
      const cfg = { agents: { entries: { main: {} } } } satisfies OpenClawConfig;
      for (const agent of ["claude", "cursor"]) {
        const key = `agent:${agent}:acp:11111111-1111-4111-8111-111111111111`;
        const acpMeta: NonNullable<SessionEntry["acp"]> = {
          backend: "acpx",
          agent,
          runtimeSessionName: key,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 1,
        };
        const entry: SessionEntry = { sessionId: `synthetic-${agent}`, updatedAt: 1, acp: acpMeta };
        expect(await prepareDeletedAgentSessionCheck({ cfg, sessionKey: key, entry })).toBe(agent);
        expect(resolveDeletedAgentIdFromSessionKey(cfg, key, acpMeta)).toBeNull();
        expect(
          resolveDeletedAgentIdFromSessionKey(cfg, `agent:${agent}:acp:binding:test`, acpMeta),
        ).toBe(agent);
      }
    });
  });

  test("deleted-agent preparation observes canonical ACP metadata across lifecycle changes", async () => {
    await withStateDirEnv("session-utils-acp-deleted-agent-repair-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "claude", "sessions", "sessions.json");
      const acpKey = "agent:claude:acp:55555555-5555-4555-8555-555555555555";
      const legacyAcpKey = "agent:CLAUDE:acp:55555555-5555-4555-8555-555555555555";
      const entry = {
        sessionId: "sess-acp-repair",
        updatedAt: 1,
        lifecycleRevision: "lifecycle-1",
      } satisfies SessionEntry;
      seedSessionEntries(storePath, {
        [acpKey]: entry,
      });
      seedCanonicalAcpSessionMeta({
        sessionKey: legacyAcpKey,
        lifecycleRevision: "lifecycle-1",
        meta: {
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: legacyAcpKey,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 1,
        },
      });
      const cfg = {
        session: {
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { entries: { main: {} } },
      } as OpenClawConfig;

      expect(
        await prepareDeletedAgentSessionCheck({
          cfg,
          sessionKey: acpKey,
          entry,
          acpMetadataSessionKey: acpKey,
        }),
      ).toBeNull();
      seedCanonicalAcpSessionMeta({
        sessionKey: acpKey,
        lifecycleRevision: "lifecycle-2",
        meta: {
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: legacyAcpKey,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 2,
        },
      });
      expect(await prepareDeletedAgentSessionCheck({ cfg, sessionKey: acpKey, entry })).toBe(
        "claude",
      );
      const replacement = { ...entry, lifecycleRevision: "lifecycle-2" };
      expect(
        await prepareDeletedAgentSessionCheck({ cfg, sessionKey: acpKey, entry: replacement }),
      ).toBeNull();
      let current = true;
      const pending = prepareDeletedAgentSessionCheck({
        cfg,
        sessionKey: acpKey,
        entry: replacement,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Gateway requester authority changed");
          }
        },
      });
      current = false;
      await expect(pending).rejects.toThrow("Gateway requester authority changed");
    });
  });
});
