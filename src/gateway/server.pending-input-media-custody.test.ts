import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
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
const REFUSAL = "Synthetic refusal before native input commit";
const LOST_REPLY = "Synthetic input reply lost after native commit";

function expectAdmissionError(response: unknown, message: string) {
  expect(response).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining(message) },
  });
}

// Lose evidence only after the real pending-input or actor transaction commits.
// The ordinary reply alone cannot establish custody; never synthesize the row.
function observeInputAdmission(
  outcome: Outcome,
  sessionKey: string,
  kind: "legacy" | "pending" | "turn",
) {
  const actor = kind !== "legacy";
  const original = workerStore.runSqliteWorkerStoreOperation;
  const counts = { attempts: 0, committed: 0, faults: 0 };
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
          counts.faults === 0 &&
          request.stage === "commit" &&
          isRecord(facts) &&
          facts.kind === "session-actor-admission" &&
          isRecord(facts.snapshot) &&
          isRecord(facts.snapshot.target) &&
          facts.snapshot.target.sessionKey === sessionKey
        ) {
          counts.faults++;
          throw new Error(REFUSAL);
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
                  counts.attempts++;
                  if (!actor && outcome === "refused") {
                    counts.faults++;
                    throw new Error(REFUSAL);
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
                counts.committed++;
                const owned = expectDefined(admission, "real staging admission");
                const input = expectDefined(
                  isRecord(command.input) ? command.input : undefined,
                  "real input admission command",
                );
                expect(owned.committed?.facts).toMatchObject(
                  actor
                    ? {
                        kind: "committed",
                        receipt: {
                          phase: "acceptInput",
                          commandId: input.commandId,
                          phaseId: input.phaseId,
                          postimage: { target: { sessionKey } },
                        },
                      }
                    : { kind: "pending-input-settlement", operation: "stage" },
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
                  counts.faults++;
                  throw new Error(LOST_REPLY);
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
    counts,
    restore: () => {
      for (const restore of restoreEvidence) {
        restore();
      }
      observer.mockRestore();
      refusalObserver.mockRestore();
    },
  };
}

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
    const saveObserver = vi.spyOn(mediaStore, "saveMediaBuffer");
    const deleteObserver = vi.spyOn(mediaStore, "deleteMediaBuffer");
    const deletions = () =>
      deleteObserver.mock.results.flatMap((result) =>
        result.type === "return" ? [result.value] : [],
      );
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
      const deletionResults = await Promise.allSettled(deletions());
      expect(staging.counts).toEqual({
        attempts: 1,
        committed: outcome === "refused" ? 0 : 1,
        faults: outcome === "accepted" ? 0 : 1,
      });
      const saved = await Promise.all(
        saveObserver.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      );
      expect(saveObserver).toHaveBeenCalledTimes(1);
      expect(saved).toHaveLength(1);
      const media = expectDefined(saved[0], "real inbound file");
      const pending = await sessionAccessor.listSessionPendingInputs(f.scope);
      const transcript = sessionAccessor.loadTranscriptEventsSync(f.scope);
      expect(pending.total).toBe(!goal && outcome === "unknown" ? 1 : 0);
      if (goal && outcome !== "refused") {
        expect(sessionAccessor.loadSessionEntry(f.scope)?.goal?.objective).toBe(request.message);
      }
      if (goal && outcome === "unknown") {
        expect(transcript.slice(0, f.before.length)).toEqual(f.before);
        // Goal failure can add a lifecycle notice. The committed user input
        // still occurs exactly once and must keep its referenced attachment.
        const inputs = transcript
          .slice(f.before.length)
          .filter(
            (event) => isRecord(event) && isRecord(event.message) && event.message.role === "user",
          );
        expect(inputs).toHaveLength(1);
        expect(JSON.stringify(inputs[0])).toContain(media.id);
      }
      if (outcome === "refused") {
        expectAdmissionError(response, REFUSAL);
        expect(transcript).toEqual(f.before);
        if (goal) {
          expect(sessionAccessor.loadSessionEntry(f.scope)?.goal).toBeUndefined();
        }
        await expect(fs.stat(media.path)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await fs.readFile(media.path)).toEqual(bytes);
        if (outcome === "unknown") {
          expectAdmissionError(
            response,
            chat ? LOST_REPLY : "commitment is unknown; do not replay",
          );
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
          expect(transcript).toHaveLength(f.before.length + 1);
          expect(JSON.stringify(transcript.at(-1))).toContain(media.id);
          expect((await send()).ok).toBe(true);
          await f.drain();
          expect(staging.counts.attempts).toBe(1);
          expect(saveObserver).toHaveBeenCalledTimes(1);
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
        await Promise.allSettled(deletions());
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
