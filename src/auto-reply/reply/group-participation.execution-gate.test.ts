import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { createSessionGoalFixture } from "../../gateway/session-goal.test-support.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { QueuedFollowupReplyBatch } from "../get-reply-options.types.js";
import { judgment } from "./group-participation.decision.test-support.js";
import {
  acceptGroupInputForActiveReply,
  fixture,
  models,
} from "./group-participation.runner.test-support.js";

it("reassesses accepted input that arrives during tool-authority preparation before typing", async () => {
  const groupId = "-10127";
  fixture.config.agents!.defaults!.typingMode = "instant";
  const start = vi.fn();
  models.decision.mockImplementationOnce(async (batch) =>
    judgment(batch, { attention: "engagement" }),
  );
  models.decision.mockImplementation(async (batch) => judgment(batch, { attention: "none" }));
  models.embedded.mockResolvedValue({
    payloads: [{ text: "Must not bypass the revised decision." }],
    meta: { durationMs: 1 },
  });
  await fixture.reply("Bob, which port?", "input-during-authority", groupId, {
    onReplyStart: start,
    onRunVerbosityResolved: () => {
      const operation = getSessionControllerOperation(`agent:main:telegram:group:${groupId}`);
      if (!operation) {
        throw new Error("The admitted reply owner is missing");
      }
      const bind = operation.bindToolAuthoritySnapshotAsync.bind(operation);
      vi.spyOn(operation, "bindToolAuthoritySnapshotAsync").mockImplementationOnce(
        async (...args) => {
          await bind(...args);
          acceptGroupInputForActiveReply(groupId);
        },
      );
    },
  });
  expect(models.decision).toHaveBeenCalledTimes(2);
  expect(models.embedded).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it.each(["user", "restart"] as const)(
  "settles final reassessment canceled by %s without reporting failure",
  async (reason) => {
    const groupId = "-10128";
    const sessionKey = `agent:main:telegram:group:${groupId}`;
    let operation: ReplyOperation | undefined;
    const terminal = vi.fn();
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath: fixture.storePath },
      {
        sessionId: "00000000-0000-4000-8000-000000010128",
        updatedAt: Date.now(),
        goal: createSessionGoalFixture("participation-goal", "Answer the outstanding question"),
      },
    );
    models.decision.mockImplementationOnce(async (batch) => judgment(batch, { attention: "none" }));
    models.decision.mockImplementation(async (batch) => {
      if (reason === "restart") {
        operation!.abortForRestart();
      } else {
        operation!.abortByUser();
      }
      return judgment(batch, { attention: "engagement" });
    });
    await fixture.reply("Bob, which port?", "cancel-reassessment", groupId, {
      onAgentRunTerminalOutcome: terminal,
      onRunVerbosityResolved: () => {
        operation = getSessionControllerOperation(sessionKey);
        acceptGroupInputForActiveReply(groupId);
      },
    });
    await operation?.ownerSettlement;
    expect(models.decision).toHaveBeenCalledTimes(2);
    expect(operation?.result?.kind).toBe("aborted");
    expect(models.embedded).not.toHaveBeenCalled();
    const entry = await readSessionEntryInWorker({ sessionKey, storePath: fixture.storePath });
    expect(entry?.status).toBe("killed");
    expect(entry?.lifecycleRunId).toBeUndefined();
    expect(entry?.goal?.status).toBe(reason === "restart" ? "active" : "paused");
    expect(terminal).not.toHaveBeenCalled();
  },
);

it.for(["restart", "authority loss"] as const)(
  "reports queued %s through its source delivery owner",
  async (reason, { signal }) => {
    const groupId = "-10129";
    const entered = createDeferred();
    const release = createDeferred();
    const delivered = createDeferred<QueuedFollowupReplyBatch>();
    let operation: ReplyOperation | undefined;
    const revocation = new AbortController();
    const failure = new Error("original operator role changed");
    fixture.config.agents!.defaults!.experimental!.decisionAssistance = reason === "restart";
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      signal: revocation.signal,
      assertCurrent: () => revocation.signal.throwIfAborted(),
    });
    models.embedded.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { payloads: [{ text: "First answer." }], meta: { durationMs: 1 } };
    });
    models.decision.mockImplementationOnce(async (batch) => judgment(batch, { attention: "none" }));
    models.decision.mockImplementation(async (batch) => {
      operation!.abortForRestart();
      return judgment(batch, { attention: "engagement" });
    });
    const first = fixture.reply(
      "Agent, first question?",
      "before-queued-cancel",
      groupId,
      undefined,
      true,
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, first, "The first reply did not start"),
        signal,
      );
      await fixture.reply("Bob, queued question?", "queued-reassessment-cancel", groupId, {
        onRunVerbosityResolved: () => {
          operation = getSessionControllerOperation(`agent:main:telegram:group:${groupId}`);
          if (!operation) {
            throw new Error("The queued reply owner is missing");
          }
          if (reason === "restart") {
            acceptGroupInputForActiveReply(groupId);
          } else {
            const bind = operation.bindToolAuthoritySnapshotAsync.bind(operation);
            vi.spyOn(operation, "bindToolAuthoritySnapshotAsync").mockImplementationOnce(
              async (snapshot) => {
                const fingerprint = snapshot.fingerprintAsync;
                if (!fingerprint) {
                  throw new Error("The reply must prepare authority asynchronously");
                }
                await bind({
                  ...snapshot,
                  fingerprintAsync: async () => {
                    const prepared = await fingerprint();
                    revocation.abort(failure);
                    return prepared;
                  },
                });
              },
            );
          }
        },
        operatorAuthority,
        onQueuedFollowupReplyBatch: (batch) => {
          if (batch.completion.kind !== "progress") {
            delivered.resolve(batch);
          }
        },
      });
    } finally {
      release.resolve();
      await first;
    }
    const batch = await withinTest(delivered.promise, signal);
    await operation?.ownerSettlement;
    expect(batch.completion).toEqual(
      reason === "restart"
        ? { kind: "aborted", stopReason: "restart" }
        : expect.objectContaining({
            kind: "failed",
            notice: expect.stringMatching(/^withheld: .+/),
          }),
    );
    expect(batch.payloads).toEqual([]);
    expect(models.embedded).toHaveBeenCalledOnce();
  },
);
