import { afterAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.entry.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { withSessionActorStorage } from "../../config/sessions/session-actor-storage-acquisition.js";
import * as approvals from "../../infra/exec-approvals-store.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { boardStore } from "../board-store.js";
import { progressCardStore } from "../progress-card-store.js";
import { createBoardHarness } from "./board.test-support.js";
import { progressCardHandlers } from "./progress-card.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";

const review = vi.hoisted(() => vi.fn());
// mock-isolation: controlled review waits must not initialize a model runtime or contact a provider.
vi.mock("../../agents/exec-auto-reviewer.js", () => ({
  createModelExecAutoReviewer: () => review,
}));

const authority = { assertCurrent() {}, authorize() {} };
const cfg = {
  agents: { entries: { main: {}, absent: {} } },
  tools: { exec: { mode: "auto" as const } },
};
const env = { OPENCLAW_STATE_DIR: "/synthetic/board-incognito-rpc" };
const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
const widget = {
  name: "status",
  content: { kind: "html" as const, html: "<p>Private status</p>" },
  declared: { tools: ["health"] },
};

function privateBoard(sessionKey: string) {
  const harness = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const target = method === "sessions.delete" ? { key: sessionKey } : { sessionKey };
    return (await harness.invoke(method, { ...target, ...params })).mock.calls[0]!;
  };
  return { ...harness, rpc };
}

beforeEach(() => {
  setRuntimeConfigSnapshot(cfg, cfg);
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  resetPluginRuntimeStateForTest();
  review.mockReset();
  const policy = vi.spyOn(approvals, "readExecApprovalsPolicyReadOnlyAsync").mockResolvedValue({
    file: { version: 1 },
    revision: "board-policy",
  });
  return () => policy.mockRestore();
});
afterAll(() => {
  memorySessionActorOwners.reset();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
});

it.each([
  "grant",
  "permission",
  "replacement",
  "approval-failure",
  "review-failure",
  "guarded",
  "closed",
] as const)(
  "retains the actor through Board put and review (%s), without replaying a committed put",
  async (outcome) => {
    const sessionKey = `agent:main:dashboard:incognito-board-${outcome}`;
    const entry = {
      sessionId: `board-${outcome}`,
      lifecycleRevision: "initial",
      updatedAt: 1,
      incognito: true as const,
      permissionMode: outcome === "guarded" ? ("guarded" as const) : ("workspace" as const),
    };
    const scope = { sessionKey, agentId: "main", storePath, env };
    const created = await withSessionActorStorage(
      scope,
      { authority, lifetime: { assertCurrent() {}, assertReadable() {} }, create: true },
      ({ actor }) =>
        actor.storage.mutate({ type: "session.entry.create", input: { entry } }, authority),
    );
    expect(created?.kind).toBe("committed");
    const harness = privateBoard(sessionKey);
    const started = createDeferred();
    const release = createDeferred();
    review.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      if (outcome === "review-failure") {
        throw new Error("Synthetic reviewer failure");
      }
      return { decision: "allow-once", risk: "low", rationale: "Synthetic Board" };
    });
    if (outcome === "approval-failure") {
      vi.mocked(approvals.readExecApprovalsPolicyReadOnlyAsync).mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        throw new Error("Synthetic policy read failure");
      });
    }
    const sql = observeMainThreadSql();
    const putting = harness.rpc("board.widget.put", widget);
    try {
      if (outcome !== "guarded") {
        await awaitGateBeforeSettlement(started.promise, putting, "Board put did not reach review");
      }
      if (outcome === "permission" || outcome === "replacement") {
        if (outcome === "permission") {
          await patchSessionEntryCore(scope, () => ({ permissionMode: "guarded" }));
        } else {
          await replaceSessionEntry(scope, {
            ...entry,
            sessionId: "replacement",
            lifecycleRevision: "replacement",
          });
        }
      }
      if (outcome === "closed") {
        memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
      }
      release.resolve();
      const response = await putting;
      const grantState =
        outcome === "grant" ? "granted" : outcome === "review-failure" ? "rejected" : "pending";
      expect(review).toHaveBeenCalledTimes(
        outcome === "approval-failure" || outcome === "guarded" ? 0 : 1,
      );
      if (["permission", "replacement", "approval-failure", "closed"].includes(outcome)) {
        expect(response[0]).toBe(false);
        expect(harness.broadcast).not.toHaveBeenCalled();
      } else {
        expect(response).toMatchObject([true, { widgets: [{ grantState }] }]);
      }
      if (outcome === "closed") {
        expect(memorySessionActorOwners.read({ agentId: "main", path: storePath })).toBeUndefined();
        sql.expectIdle();
        return;
      }
      const stored = await boardStore.getSnapshot({ sessionKey });
      expect(stored).toMatchObject({
        revision: outcome === "grant" || outcome === "review-failure" ? 2 : 1,
        widgets: [{ grantState }],
      });
      sql.expectIdle();
    } finally {
      release.resolve();
      await putting;
      sql.restore();
    }
  },
);

it("returns explicit absence without opening Board, progress, or deletion sources", async () => {
  const sessionKey = "agent:absent:dashboard:incognito-missing";
  const harness = privateBoard(sessionKey);
  Object.assign(harness.handlers, progressCardHandlers, sessionDeleteHandlers);
  const sql = observeMainThreadSql();
  onTestFinished(() => sql.restore());
  expect(await harness.rpc("board.get")).toMatchObject([true, { revision: 0, widgets: [] }]);
  expect(await boardStore.readWidgetMcpApp({ sessionKey }, "missing")).toBeUndefined();
  await expect(boardStore.putWidget({ ...widget, sessionKey })).rejects.toMatchObject({
    code: "not_found",
  });
  expect(await progressCardStore.get(sessionKey)).toBeNull();
  await expect(progressCardStore.put(sessionKey, { markdown: "Absent" })).rejects.toBeInstanceOf(
    IncognitoSessionMissingError,
  );
  expect(
    await harness.rpc("progressCard.refresh", { idempotencyKey: "missing-card" }),
  ).toMatchObject([false, undefined, { message: "There is no progress card to refresh." }]);
  expect(await harness.rpc("sessions.delete")).toEqual([
    true,
    { ok: true, key: sessionKey, deleted: false, archived: [] },
    undefined,
  ]);
  expect((await harness.rpc("sessions.delete", { expectedSessionId: "old" }))[0]).toBe(false);
  sql.expectIdle();
  expect(memorySessionActorOwners.list().some((owner) => owner.agentId === "absent")).toBe(false);
});
