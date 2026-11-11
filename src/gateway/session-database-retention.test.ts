import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { expectCollected, weak } from "./session-collection.test-support.js";
import { withAcceptedSuffix } from "./session-row-projection.accepted-facts.test-support.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

const unavailableMessage =
  "Session access facts are unavailable; retry after session storage is ready.";

it("does not render the accepted suffix after dispose", async () => {
  const refs: WeakRef<object>[] = [];
  await withAcceptedSuffix(async ({ projection, suffix, query, resume }) => {
    const pending = weak(suffix.pendingDatabaseFacts!);
    refs.push(weak({}), pending);
    projection.dispose();
    await resume();
    expect(projection.isCurrent(suffix)).toBe(false);
    expect(projection.snapshot(query).row?.label ?? null).toBe(null);
  });
  // Restoring spies does not clear their recorded fixture arguments or results.
  vi.clearAllMocks();
  await expectCollected(...refs);
});

it("does not retain discovery context in active session authority", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const target = { agentId: "main", sessionKey: "agent:main:retention" };
    const prepare = () => prepareSessionMutationFacts({ cfg, ...target });
    replaceSessionEntrySync(target, { sessionId: "retention", updatedAt: 1 });
    (await prepare()).release();
    const scope = new AsyncLocalStorage<object>();
    async function capture() {
      const payload = { sessions: [{ sessionId: "completed-unrelated-session" }] };
      const facts = await scope.run(payload, prepare);
      return { facts, payload: weak(payload), control: weak({}) };
    }
    const retained = await capture();
    try {
      await expectCollected(retained.control, retained.payload);
      expect(retained.facts.readCurrent(cfg).target.entry.sessionId).toBe("retention");
      retained.facts.release();
      expect(() => retained.facts.readCurrent(cfg)).toThrow(unavailableMessage);
    } finally {
      retained.facts.release();
      scope.disable();
    }
  }));
