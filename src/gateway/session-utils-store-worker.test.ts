import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySessionStore } from "./session-utils-store-read.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

it("keeps store keys as mutable ordered data without copying entries", () => {
  const first = Object.freeze({ sessionId: "first", updatedAt: 1 });
  const last = Object.freeze({ sessionId: "last", updatedAt: 2 });
  const store = createGatewaySessionStore([
    { sessionKey: "__proto__", entry: first },
    { sessionKey: "agent:main:subagent:one", entry: first },
    { sessionKey: "__proto__", entry: last },
  ]);
  expect(Object.getPrototypeOf(store)).toBeNull();
  expect(Object.keys(store)).toEqual(["__proto__", "agent:main:subagent:one"]);
  expect(Object.getOwnPropertyDescriptor(store, "__proto__")?.value).toBe(last);
  expect(store["agent:main:subagent:one"]).toBe(first);
  expect(JSON.stringify(store)).toBe(
    '{"__proto__":{"sessionId":"last","updatedAt":2},"agent:main:subagent:one":{"sessionId":"first","updatedAt":1}}',
  );
  store["agent:main:subagent:two"] = last;
  delete store["agent:main:subagent:one"];
  expect(Object.keys(store)).toEqual(["__proto__", "agent:main:subagent:two"]);
});

it("preserves customized main aliases, saved instructions, and hidden-effect exclusion", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      session: { mainKey: "primary" },
    };
    const sessionKey = "agent:main:primary";
    const seed = (key: string, entry: SessionEntry) =>
      replaceSessionEntrySync({ agentId: "main", sessionKey: key, env }, entry);
    const skillsSnapshot = { prompt: "Complete saved skill instructions", skills: [] };
    seed(sessionKey, { sessionId: "worker-projection", updatedAt: 1, skillsSnapshot });
    const input = { cfg, key: "main", agentId: "main", env };
    const read = (key = "main", excludeInternalEffects = false) =>
      loadGatewaySessionEntryReadOnlyInWorker({ ...input, key, excludeInternalEffects });
    await read();
    const internalKey = "agent:main:internal-session-effects:fixture";
    seed(internalKey, { sessionId: "internal-effects", updatedAt: 1 });
    const sibling = "agent:main:unrelated";
    seed(sibling, { sessionId: sibling, updatedAt: 1 });
    const sql = observeHostDataSql();
    {
      using _ = { [Symbol.dispose]: sql.restore };
      const loaded = await read();
      expect(loaded.canonicalKey).toBe(sessionKey);
      expect(loaded.entry).toMatchObject({ sessionId: "worker-projection", skillsSnapshot });
      expect(Object.getPrototypeOf(loaded.store)).toBeNull();
      expect(loaded.store[sessionKey]).toBe(loaded.entry);
      const ordinary = await read(internalKey, true);
      expect([ordinary.entry, ordinary.store[internalKey]]).toEqual([undefined, undefined]);
      expect((await read(internalKey)).entry?.sessionId).toBe("internal-effects");
      expect(
        sql.queries.filter((query) =>
          /\bfrom\s+"?session_(?:nodes|windows|participants)\b/i.test(query),
        ),
      ).toEqual([]);
    }
    seed(sessionKey, { sessionId: "updated-parent", updatedAt: 2, label: "Updated" });
    expect((await read()).entry).toMatchObject({ sessionId: "updated-parent", label: "Updated" });
  });
});

it("rechecks caller authority before returning prepared Gateway metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    const sessionKey = "agent:main:primary";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, env },
      { sessionId: "worker-authority", updatedAt: 1 },
    );
    const revoked = new Error("original caller revoked");
    const assertActive = vi.fn();
    const read = loadGatewaySessionEntryReadOnlyInWorker({
      cfg,
      key: sessionKey,
      agentId: "main",
      env,
      assertActive,
    });
    assertActive.mockImplementation(() => {
      throw revoked;
    });
    await expect(read).rejects.toBe(revoked);
  });
});
