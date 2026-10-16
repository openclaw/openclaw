import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import * as mediaStore from "../media/store.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import * as agentAdmission from "./agent-turn/agent-run-admission-phase.js";
import * as sessionChangeEvent from "./server-methods/session-change-event.js";
import { dispatchGatewayMethodInProcessRaw } from "./server-plugin-in-process-dispatch.js";
import {
  installAgentAuthorityProofFixture,
  PNG,
} from "./server.agent-runtime-authority-proof.test-support.js";
import { createGoalChatStartRequest } from "./server.chat-goal.test-support.js";
import { agentCommandMock, dispatchInboundMessageMock } from "./test-helpers.js";

type Outcome = "unknown" | "refused" | "accepted" | "reply lost";

// Lose evidence only after the real pending-input or actor transaction commits.
// The ordinary reply alone cannot establish custody; never synthesize the row.
function observeInputAdmission(
  outcome: Outcome,
  sessionKey: string,
  kind: "legacy" | "pending" | "turn",
) {
  const actor = kind !== "legacy";
  const original = workerStore.runSqliteWorkerStoreOperation;
  let attempts = 0;
  let committed = 0;
  let faults = 0;
  let capturingInput = false;
  const restoreEvidence: (() => void)[] = [];
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const refusalObserver = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) => {
      const selected = capturingInput;
      return createAdmission((request, grant) => {
        const facts = isRecord(request.facts) ? request.facts.publication : undefined;
        if (
          selected &&
          outcome === "refused" &&
          faults === 0 &&
          request.stage === "commit" &&
          isRecord(facts) &&
          facts.kind === "session-actor-admission" &&
          isRecord(facts.snapshot) &&
          isRecord(facts.snapshot.target) &&
          facts.snapshot.target.sessionKey === sessionKey
        ) {
          faults++;
          throw new Error("Synthetic refusal before native input commit");
        }
        admit(request, grant);
      }, attachment);
    });
  const observer = vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        target: SqliteWorkerStore<Operations>,
        operation: (worker: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof original>[2],
        assertCurrent?: Parameters<typeof original>[3],
        createRetainedAdmission?: Parameters<typeof original>[4],
      ) => {
        let staging = false;
        let admission: SqliteWorkerOperationAdmission | undefined;
        return original(
          target,
          (worker) =>
            operation({
              execute: async (command, options) => {
                staging = actor
                  ? command.type === "session.actor.acceptInput" &&
                    isRecord(command.input) &&
                    (kind === "pending"
                      ? isRecord(command.input.pending) && command.input.pending.kind === "stage"
                      : command.input.pending === undefined && isRecord(command.input.turn)) &&
                    isRecord(command.input.target) &&
                    command.input.target.sessionKey === sessionKey
                  : command.type === "session.pendingInputs.mutate" &&
                    isRecord(command.input) &&
                    command.input.kind === "stage";
                if (staging) {
                  attempts++;
                  if (!actor && outcome === "refused") {
                    faults++;
                    throw new Error("Synthetic refusal before native input commit");
                  }
                }
                const result = await worker.execute(command, options);
                if (!staging) {
                  return result;
                }
                if (actor && outcome === "refused") {
                  expect(result).toMatchObject({ kind: "rolled-back" });
                  return result;
                }
                committed++;
                const owned = expectDefined(admission, "real staging admission");
                const input = expectDefined(
                  isRecord(command.input) ? command.input : undefined,
                  "real input admission command",
                );
                expect(owned.committed).toMatchObject(
                  actor
                    ? {
                        facts: {
                          kind: "committed",
                          receipt: {
                            phase: "acceptInput",
                            commandId: input.commandId,
                            phaseId: input.phaseId,
                            postimage: { target: { sessionKey } },
                          },
                        },
                      }
                    : { facts: { kind: "pending-input-settlement", operation: "stage" } },
                );
                expect(owned.settlement?.kind).toBe("completed");
                if (outcome === "unknown") {
                  const settlement = vi
                    .spyOn(owned, "settlement", "get")
                    .mockReturnValue({ ...owned.settlement, kind: "unknown" });
                  restoreEvidence.push(() => settlement.mockRestore());
                  if (actor) {
                    // The actor recovers a lost reply from its native witness.
                    // Lose that witness too, before its committed observer runs.
                    const witness = vi.spyOn(owned, "committed", "get").mockReturnValue(undefined);
                    restoreEvidence.push(() => witness.mockRestore());
                  }
                }
                if (outcome === "unknown" || outcome === "reply lost") {
                  faults++;
                  throw new Error("Synthetic input reply lost after native commit");
                }
                return result;
              },
            }),
          stateContext,
          assertCurrent,
          createRetainedAdmission &&
            ((retained) => {
              capturingInput = actor && staging;
              try {
                const owned = createRetainedAdmission(retained);
                if (staging) {
                  admission = owned.admission;
                }
                return owned;
              } finally {
                capturingInput = false;
              }
            }),
        );
      },
    );
  return {
    attempts: () => attempts,
    committed: () => committed,
    faults: () => faults,
    restore: () => {
      for (const restore of restoreEvidence) {
        restore();
      }
      observer.mockRestore();
      refusalObserver.mockRestore();
    },
  };
}

describe("Gateway pending-input media custody", () => {
  const fixture = installAgentAuthorityProofFixture();

  it.for(
    (["agent inline", "agent offloaded", "chat offloaded", "goal offloaded"] as const).flatMap(
      (route) =>
        (route === "chat offloaded" || route === "goal offloaded"
          ? (["unknown", "refused", "accepted", "reply lost"] as const)
          : (["unknown", "refused", "accepted"] as const)
        ).map((outcome) => ({ route, outcome })),
    ),
  )(
    "preserves the $route attachment according to $outcome admission",
    async ({ route, outcome }, { signal }) => {
      const f = await fixture({ imageCapable: true });
      const goal = route === "goal offloaded";
      const chat = route === "chat offloaded" || goal;
      const accepted = outcome === "accepted" || outcome === "reply lost";
      const bytes = chat
        ? Buffer.from("synthetic inbound attachment")
        : route === "agent offloaded"
          ? Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(2_000_001)])
          : Buffer.from(PNG, "base64");
      const request = {
        message: "retain the attachment with its admitted input",
        attachments: [
          {
            mimeType: chat ? "text/plain" : "image/png",
            fileName: chat ? "notes.txt" : "image.png",
            content: bytes.toString("base64"),
          },
        ],
      };
      const saved: mediaStore.SavedMedia[] = [];
      const deletions: Promise<void>[] = [];
      const save = mediaStore.saveMediaBuffer;
      const remove = mediaStore.deleteMediaBuffer;
      const saveObserver = vi
        .spyOn(mediaStore, "saveMediaBuffer")
        .mockImplementation(async (...args) => {
          const result = await save(...args);
          saved.push(result);
          return result;
        });
      const deleteObserver = vi
        .spyOn(mediaStore, "deleteMediaBuffer")
        .mockImplementation((...args) => {
          const result = remove(...args);
          deletions.push(result);
          return result;
        });
      const staging = observeInputAdmission(
        outcome,
        f.sessionKey,
        goal ? "turn" : chat ? "pending" : "legacy",
      );
      const prepare = agentAdmission.prepareAgentRunDispatch;
      const mediaTransferred = vi.fn();
      const admissionObserver = vi
        .spyOn(agentAdmission, "prepareAgentRunDispatch")
        .mockImplementation((params) =>
          prepare({
            ...params,
            onUserTurnMediaPersisted: () => {
              mediaTransferred();
              params.onUserTurnMediaPersisted();
            },
          }),
        );
      const chatSettled = createDeferred();
      const emitChange = sessionChangeEvent.emitSessionsChanged;
      const settlementObserver = vi
        .spyOn(sessionChangeEvent, "emitSessionsChanged")
        .mockImplementation((...args) => {
          emitChange(...args);
          if (
            args[0] === f.context &&
            args[1].sessionKey === f.sessionKey &&
            args[1].reason === "agent.input.settled"
          ) {
            chatSettled.resolve();
          }
        });
      const persist = async (recorder: UserTurnTranscriptRecorder | undefined) => {
        const owned = expectDefined(recorder, "admitted dispatch recorder");
        expect((await owned.persistApproved())?.appended).toBe(true);
      };
      agentCommandMock.mockImplementation(async (input) => {
        await persist((input as AgentCommandGatewayIngressOpts).userTurnTranscriptRecorder);
      });
      dispatchInboundMessageMock.mockImplementation(async (input: unknown) => {
        const { replyOptions } = input as Parameters<typeof dispatchInboundMessage>[0];
        await persist(replyOptions?.userTurnTranscriptRecorder);
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
      const requestIdentity = goal
        ? createGoalChatStartRequest(f, request.message, f.runId)
        : { sessionKey: f.sessionKey, idempotencyKey: f.runId };
      const send = () =>
        chat
          ? dispatchGatewayMethodInProcessRaw(
              "chat.send",
              { ...request, ...requestIdentity },
              {
                forceSyntheticClient: true,
                syntheticScopes: ["operator.admin"],
                resolveGatewayContext: () => f.context,
              },
            )
          : f.dispatch(request, null);
      try {
        const response = await send();
        if (chat && accepted) {
          expect(response.ok).toBe(true);
          // Chat dispatch is detached from the request owner. Its exact settled
          // event follows dispatch finalization, not just the started ACK.
          await withinTest(chatSettled.promise, signal);
        }
        // Join the actual handler, including the agent service's outer finally,
        // then every real file deletion requested by detached chat cleanup.
        await f.drain();
        const deletionResults = await Promise.allSettled(deletions);
        expect(staging.attempts()).toBe(1);
        expect(staging.committed()).toBe(outcome === "refused" ? 0 : 1);
        expect(staging.faults()).toBe(outcome === "accepted" ? 0 : 1);
        expect(saved).toHaveLength(1);
        const media = expectDefined(saved[0], "real inbound file");
        const pending = await sessionAccessor.listSessionPendingInputs(f.scope);
        const transcript = sessionAccessor.loadTranscriptEventsSync(f.scope);
        if (goal && outcome === "unknown") {
          expect(response).toMatchObject({
            ok: false,
            error: {
              message: expect.stringContaining("Synthetic input reply lost after native commit"),
            },
          });
          expect(pending.total).toBe(0);
          expect(sessionAccessor.loadSessionEntry(f.scope)?.goal?.objective).toBe(request.message);
          expect(transcript.slice(0, f.before.length)).toEqual(f.before);
          // Goal failure can add a lifecycle notice. The committed user input
          // still occurs exactly once and must keep its referenced attachment.
          const inputs = transcript
            .slice(f.before.length)
            .filter(
              (event) =>
                isRecord(event) && isRecord(event.message) && event.message.role === "user",
            );
          expect(inputs).toHaveLength(1);
          expect(JSON.stringify(inputs[0])).toContain(media.id);
          expect(agentCommandMock).not.toHaveBeenCalled();
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        }
        if (outcome === "refused") {
          expect(response).toMatchObject({
            ok: false,
            error: {
              message: expect.stringContaining("Synthetic refusal before native input commit"),
            },
          });
          expect(pending.total).toBe(0);
          expect(transcript).toEqual(f.before);
          if (goal) {
            expect(sessionAccessor.loadSessionEntry(f.scope)?.goal).toBeUndefined();
          }
          await expect(fs.stat(media.path)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(media.path)).toEqual(bytes);
          expect(deleteObserver).not.toHaveBeenCalledWith(media.id, "inbound");
          if (outcome === "unknown") {
            expect(response).toMatchObject({
              ok: false,
              error: {
                message: expect.stringContaining(
                  chat
                    ? "Synthetic input reply lost after native commit"
                    : "commitment is unknown; do not replay",
                ),
              },
            });
            // UNKNOWN never publishes a live input owner. The public history
            // read reconciles that committed, ownerless row to interrupted.
            if (!goal) {
              expect(pending).toMatchObject({
                total: 1,
                items: [{ runId: f.runId, state: "interrupted" }],
              });
              expect(JSON.stringify(pending.items[0]?.message)).toContain(media.id);
              expect(transcript).toEqual(f.before);
            }
          } else {
            expect(response.ok).toBe(true);
            if (goal) {
              expect(sessionAccessor.loadSessionEntry(f.scope)?.goal?.objective).toBe(
                request.message,
              );
            }
            expect(pending.total).toBe(0);
            expect(transcript).toHaveLength(f.before.length + 1);
            expect(JSON.stringify(transcript.at(-1))).toContain(media.id);
            expect((await send()).ok).toBe(true);
            await f.drain();
            expect(staging.attempts()).toBe(1);
            expect(saved).toHaveLength(1);
            expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(transcript);
            expect(await fs.readFile(media.path)).toEqual(bytes);
          }
        }
        for (const result of deletionResults) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
        expect(deleteObserver).toHaveBeenCalledTimes(outcome === "refused" ? 1 : 0);
        expect(mediaTransferred).toHaveBeenCalledTimes(!chat && outcome !== "refused" ? 1 : 0);
        expect(agentCommandMock).toHaveBeenCalledTimes(accepted && !chat ? 1 : 0);
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(accepted && chat ? 1 : 0);
      } finally {
        try {
          await f.cleanup();
        } finally {
          await Promise.allSettled(deletions);
          staging.restore();
          admissionObserver.mockRestore();
          settlementObserver.mockRestore();
          saveObserver.mockRestore();
          deleteObserver.mockRestore();
          agentCommandMock.mockReset();
          dispatchInboundMessageMock.mockReset();
        }
      }
    },
  );
});
