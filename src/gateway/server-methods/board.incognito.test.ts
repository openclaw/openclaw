import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.entry.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import * as approvals from "../../infra/exec-approvals-store.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { boardStore } from "../board-store.js";
import { progressCardStore } from "../progress-card-store.js";
import { createBoardHarness } from "./board.test-support.js";
import { createProgressCardHandlers } from "./progress-card.js";
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

beforeAll(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  setRuntimeConfigSnapshot(cfg, cfg);
});

async function createSession(sessionKey: string, entry: SessionEntry) {
  const binding = await acquireSessionActorStorage(
    { sessionKey, agentId: "main", storePath, env },
    { authority, lifetime: { assertCurrent() {}, assertReadable() {} }, create: true },
  );
  assert(binding);
  try {
    const result = await binding.actor.storage.mutate(
      { type: "session.entry.create", input: { entry } },
      authority,
    );
    expect(result.kind).toBe("committed");
  } finally {
    await binding.actor.release();
  }
}

beforeEach(() => {
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

it.each(["grant", "permission", "replacement", "approval-failure", "review-failure"] as const)(
  "retains the actor through Board put and review (%s), without replaying a committed put",
  async (outcome) => {
    const sessionKey = `agent:main:dashboard:incognito-board-${outcome}`;
    const entry = {
      sessionId: `board-${outcome}`,
      lifecycleRevision: "initial",
      updatedAt: 1,
      incognito: true as const,
      permissionMode: "workspace" as const,
    };
    await createSession(sessionKey, entry);
    const harness = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });
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
    const putting = harness.invoke("board.widget.put", {
      sessionKey,
      name: "status",
      content: { kind: "html", html: "<p>Private status</p>" },
      declared: { tools: ["health"] },
    });
    try {
      await awaitGateBeforeSettlement(started.promise, putting, "Board put did not reach review");
      if (outcome === "permission" || outcome === "replacement") {
        const scope = { sessionKey, agentId: "main", storePath, env };
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
      release.resolve();
      const response = await putting;
      if (outcome === "permission" || outcome === "replacement" || outcome === "approval-failure") {
        expect(response.mock.calls[0]?.[0]).toBe(false);
        expect(harness.broadcast).not.toHaveBeenCalled();
      } else {
        expect(response).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            widgets: [
              expect.objectContaining({ grantState: outcome === "grant" ? "granted" : "rejected" }),
            ],
          }),
        );
      }
      const stored = await boardStore.getSnapshot({ sessionKey });
      expect(stored.widgets).toHaveLength(1);
      expect(stored.revision).toBe(outcome === "grant" || outcome === "review-failure" ? 2 : 1);
      expect(stored.widgets[0]?.grantState).toBe(
        outcome === "grant" ? "granted" : outcome === "review-failure" ? "rejected" : "pending",
      );
      expect(review).toHaveBeenCalledTimes(outcome === "approval-failure" ? 0 : 1);
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
  const harness = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });
  Object.assign(harness.handlers, createProgressCardHandlers(), sessionDeleteHandlers);
  const sql = observeMainThreadSql();
  try {
    const read = await harness.invoke("board.get", { sessionKey });
    expect(read).toHaveBeenCalledWith(true, expect.objectContaining({ revision: 0, widgets: [] }));
    expect(await boardStore.readWidgetMcpApp({ sessionKey }, "missing")).toBeUndefined();
    await expect(
      boardStore.putWidget({
        sessionKey,
        name: "status",
        content: { kind: "html", html: "<p>Absent</p>" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await progressCardStore.get(sessionKey)).toBeNull();
    await expect(progressCardStore.put(sessionKey, { markdown: "Absent" })).rejects.toBeInstanceOf(
      IncognitoSessionMissingError,
    );
    const refresh = await harness.invoke("progressCard.refresh", {
      sessionKey,
      idempotencyKey: "missing-card",
    });
    expect(refresh).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "There is no progress card to refresh." }),
    );
    const deleted = await harness.invoke("sessions.delete", { key: sessionKey });
    expect(deleted).toHaveBeenCalledWith(
      true,
      { ok: true, key: sessionKey, deleted: false, archived: [] },
      undefined,
    );
    const changed = await harness.invoke("sessions.delete", {
      key: sessionKey,
      expectedSessionId: "old",
    });
    expect(changed.mock.calls[0]?.[0]).toBe(false);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
  expect(memorySessionActorOwners.list().some((owner) => owner.agentId === "absent")).toBe(false);
});

it("reads guarded permission mode from the memory owner before granting a widget", async () => {
  const sessionKey = "agent:main:dashboard:incognito-guarded";
  await createSession(sessionKey, {
    sessionId: "guarded-widget",
    updatedAt: 1,
    incognito: true,
    permissionMode: "guarded",
  });
  const harness = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });
  const response = await harness.invoke("board.widget.put", {
    sessionKey,
    name: "health",
    content: { kind: "html", html: "<p>health</p>" },
    declared: { tools: ["health"] },
  });
  expect(response).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      widgets: [expect.objectContaining({ grantState: "pending" })],
    }),
  );
  expect(review).not.toHaveBeenCalled();
});

it("refuses a pending Board approval after its memory owner closes", async () => {
  const sessionKey = "agent:main:dashboard:incognito-board-close";
  await createSession(sessionKey, {
    sessionId: "closing-widget",
    updatedAt: 1,
    incognito: true,
    permissionMode: "workspace",
  });
  const harness = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });
  const started = createDeferred();
  const finish = createDeferred();
  review.mockImplementation(async () => {
    started.resolve();
    await finish.promise;
    return { decision: "allow-once", risk: "low", rationale: "Synthetic Board" };
  });
  const putting = harness.invoke("board.widget.put", {
    sessionKey,
    name: "health",
    content: { kind: "html", html: "<p>health</p>" },
    declared: { tools: ["health"] },
  });
  try {
    await awaitGateBeforeSettlement(started.promise, putting, "Board put did not reach review");
    memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
    finish.resolve();
    const response = await putting;
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(harness.broadcast).not.toHaveBeenCalled();
    expect(memorySessionActorOwners.read({ agentId: "main", path: storePath })).toBeUndefined();
  } finally {
    finish.resolve();
    await putting;
  }
});
