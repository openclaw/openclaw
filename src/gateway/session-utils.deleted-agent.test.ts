import path from "node:path";
import { expect, test, vi } from "vitest";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import {
  prepareDeletedAgentSessionCheck as prepareCheck,
  resolveDeletedAgentIdFromSessionKey as deletedAgent,
} from "./session-utils-store.js";
import { seedSessionEntries, withStateDirEnv } from "./session-utils.test-support.js";

type AcpMeta = NonNullable<SessionEntry["acp"]>;
const configured = { agents: { entries: { main: {} } } };
function acpMeta(agent: string, key: string, lastActivityAt = 1): AcpMeta {
  return {
    backend: "acpx",
    agent,
    runtimeSessionName: key,
    mode: "oneshot",
    state: "idle",
    lastActivityAt,
  };
}

test("deleted-agent resolution rejects non-alias main keys when main is absent", () => {
  const cfg = { session: { mainKey: "work" }, agents: { entries: { ops: {} } } };
  const alias = resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" });
  expect(alias).toBe("agent:ops:work");
  for (const key of [alias, "global", "unknown", "main"]) {
    expect(deletedAgent(cfg, key), key).toBeNull();
  }
  expect(deletedAgent(cfg, "agent:main:discord:direct:u1")).toBe("main");
});

test("deleted-agent checks require canonical ACP metadata instead of embedded entries", async () => {
  await withStateDirEnv("session-utils-acp-canonical-facts-", async () => {
    for (const agent of ["claude", "cursor"]) {
      const key = `agent:${agent}:acp:11111111-1111-4111-8111-111111111111`;
      const meta = acpMeta(agent, key);
      const entry = { sessionId: `synthetic-${agent}`, updatedAt: 1, acp: meta };
      expect(await prepareCheck({ cfg: configured, sessionKey: key, entry })).toBe(agent);
      expect(deletedAgent(configured, key, meta)).toBeNull();
      expect(deletedAgent(configured, `agent:${agent}:acp:binding:test`, meta)).toBe(agent);
    }
  });
});

test("deleted-agent preparation observes canonical ACP metadata across lifecycle changes", async () => {
  await withStateDirEnv("session-utils-acp-deleted-agent-repair-", async ({ stateDir }) => {
    const key = "agent:claude:acp:55555555-5555-4555-8555-555555555555";
    const legacyKey = key.replace("claude", "CLAUDE");
    const entry = { sessionId: "sess-acp-repair", updatedAt: 1, lifecycleRevision: "lifecycle-1" };
    const cfg = {
      ...configured,
      session: {
        store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    seedSessionEntries(path.join(stateDir, "agents", "claude", "sessions", "sessions.json"), {
      [key]: entry,
    });
    seedCanonicalAcpSessionMeta({
      sessionKey: legacyKey,
      lifecycleRevision: "lifecycle-1",
      meta: acpMeta("claude", legacyKey),
    });
    const input = { cfg, sessionKey: key, entry };
    expect(await prepareCheck({ ...input, acpMetadataSessionKey: key })).toBeNull();
    seedCanonicalAcpSessionMeta({
      sessionKey: key,
      lifecycleRevision: "lifecycle-2",
      meta: acpMeta("claude", legacyKey, 2),
    });
    expect(await prepareCheck(input)).toBe("claude");
    const replacement = { ...entry, lifecycleRevision: "lifecycle-2" };
    expect(await prepareCheck({ ...input, entry: replacement })).toBeNull();
    const assertCurrent = vi.fn();
    const pending = prepareCheck({ ...input, entry: replacement, assertCurrent });
    assertCurrent.mockImplementation(() => {
      throw new Error("Gateway requester authority changed");
    });
    await expect(pending).rejects.toThrow("Gateway requester authority changed");
  });
});
