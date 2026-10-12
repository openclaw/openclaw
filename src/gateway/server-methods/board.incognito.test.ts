import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.entry.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import * as approvals from "../../infra/exec-approvals-store.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  IncognitoSessionEndedError,
  IncognitoSessionMissingError,
} from "../../state/incognito-session-error.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
const cfg = {
  agents: { entries: { main: {}, absent: {} } },
  tools: { exec: { mode: "auto" as const } },
};
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("board-incognito-rpc-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  setRuntimeConfigSnapshot(cfg, cfg);
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});
beforeEach(() => {
  resetPluginRuntimeStateForTest();
  review.mockReset();
  const policy = vi.spyOn(approvals, "readExecApprovalsPolicyReadOnlyAsync").mockResolvedValue({
    file: { version: 1 },
    revision: "board-policy",
  });
  return () => policy.mockRestore();
});
afterAll(async () => {
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
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
    await actor.sessions.create(authority, { sessionKey, entry });
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
    const putting = withIncognitoSessionActor(actor, () =>
      harness.invoke("board.widget.put", {
        sessionKey,
        name: "status",
        content: { kind: "html", html: "<p>Private status</p>" },
        declared: { tools: ["health"] },
      }),
    );
    try {
      await awaitGateBeforeSettlement(started.promise, putting, "Board put did not reach review");
      if (outcome === "permission" || outcome === "replacement") {
        const scope = { sessionKey, agentId: actor.agentId, storePath: actor.path, env };
        await withIncognitoSessionActor(actor, async () => {
          if (outcome === "permission") {
            await patchSessionEntryCore(scope, () => ({ permissionMode: "guarded" }));
          } else {
            await replaceSessionEntry(scope, {
              ...entry,
              sessionId: "replacement",
              lifecycleRevision: "replacement",
            });
          }
        });
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
      const stored = await withIncognitoSessionActor(actor, () =>
        boardStore.getSnapshot({ sessionKey }),
      );
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

it("returns explicit absence without opening native Board, progress, or deletion sources", async () => {
  const sessionKey = "agent:absent:dashboard:incognito-missing";
  const harness = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });
  Object.assign(harness.handlers, createProgressCardHandlers(), sessionDeleteHandlers);
  await withIncognitoSessionBinding(
    { kind: "absent", agentId: "absent", env, authority },
    async () => {
      const sql = observeMainThreadSql();
      try {
        const read = await harness.invoke("board.get", { sessionKey });
        expect(read).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ revision: 0, widgets: [] }),
        );
        expect(await boardStore.readWidgetMcpApp({ sessionKey }, "missing")).toBeUndefined();
        await expect(
          boardStore.putWidget({
            sessionKey,
            name: "status",
            content: { kind: "html", html: "<p>Absent</p>" },
          }),
        ).rejects.toBeInstanceOf(IncognitoSessionMissingError);
        expect(await progressCardStore.get(sessionKey)).toBeNull();
        await expect(
          progressCardStore.put(sessionKey, { markdown: "Absent" }),
        ).rejects.toBeInstanceOf(IncognitoSessionMissingError);
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
    },
  );
  expect(
    captureOpenClawAgentDatabaseExecution.listIncognito(env).map((owner) => owner.agentId),
  ).toEqual(["main"]);
});

it("does not turn a retained ended actor into a fresh missing result", async () => {
  const ended = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "absent",
    env,
    authority,
  });
  assert(ended);
  await ended.close();
  const sessionKey = "agent:absent:dashboard:incognito-ended";
  const harness = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });
  Object.assign(harness.handlers, sessionDeleteHandlers);
  await withIncognitoSessionBinding({ actor: ended }, async () => {
    const sql = observeMainThreadSql();
    try {
      await expect(boardStore.getSnapshot({ sessionKey })).rejects.toBeInstanceOf(
        IncognitoSessionEndedError,
      );
      await expect(progressCardStore.get(sessionKey)).rejects.toBeInstanceOf(
        IncognitoSessionEndedError,
      );
      await expect(harness.invoke("sessions.delete", { key: sessionKey })).rejects.toBeInstanceOf(
        IncognitoSessionEndedError,
      );
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("joins an accepted Board approval before releasing its captured actor borrow", async () => {
  const sessionKey = "agent:main:dashboard:incognito-board-release";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId: "board-release",
      updatedAt: 1,
      incognito: true,
      permissionMode: "workspace",
    },
  });
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: actor.agentId,
    env,
    authority,
    existingOnly: true,
  });
  assert(borrowed);
  const harness = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });
  const entered = createDeferred();
  const finish = createDeferred();
  review.mockImplementation(async () => {
    entered.resolve();
    await finish.promise;
    return { decision: "allow-once", risk: "low", rationale: "Synthetic Board" };
  });
  const respond = vi.fn();
  const params = {
    sessionKey,
    name: "status",
    content: { kind: "html", html: "<p>Private status</p>" },
    declared: { tools: ["health"] },
  };
  const putting = withIncognitoSessionActor(borrowed, async () => {
    await harness.handlers["board.widget.put"]!({
      req: { type: "req", id: "board-release", method: "board.widget.put", params },
      params,
      client: null,
      context: harness.context,
      respond,
      isWebchatConnect: () => false,
    });
  });
  const outcome = Promise.allSettled([putting]);
  let released = false;
  let releasing: Promise<void> | undefined;
  try {
    await awaitGateBeforeSettlement(entered.promise, putting, "Board put did not reach review");
    releasing = borrowed.release().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    finish.resolve();
    expect(await outcome).toMatchObject([
      { status: "rejected", reason: { message: "Incognito execution reference is released" } },
    ]);
    await releasing;
    expect(released).toBe(true);
    expect(respond.mock.calls.some(([ok]) => ok === true)).toBe(false);
    const stored = await withIncognitoSessionActor(actor, () =>
      boardStore.getSnapshot({ sessionKey }),
    );
    expect(stored.widgets).toHaveLength(1);
  } finally {
    finish.resolve();
    await outcome;
    await borrowed.release();
    await releasing;
  }
});
