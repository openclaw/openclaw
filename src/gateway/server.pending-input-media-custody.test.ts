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
import * as workerStore from "../infra/sqlite-worker-store.js";
import * as mediaStore from "../media/store.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import * as sessionChangeEvent from "./server-methods/session-change-event.js";
import { dispatchGatewayMethodInProcessRaw } from "./server-plugin-in-process-dispatch.js";
import {
  installAgentAuthorityProofFixture,
  PNG,
} from "./server.agent-runtime-authority-proof.test-support.js";
import { agentCommandMock, dispatchInboundMessageMock } from "./test-helpers.js";

type Outcome = "unknown" | "refused" | "accepted";

// Exercise the real staging transaction before losing its reply/settlement, as
// in session-pending-input-operations.test.ts. Never synthesize the durable row.
function observeStaging(outcome: Outcome) {
  const original = workerStore.runSqliteWorkerStoreOperation;
  let attempts = 0;
  let committed = 0;
  let restoreSettlement: (() => void) | undefined;
  const observer = vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        target: SqliteWorkerStore<Operations>,
        operation: (worker: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof original>[2],
        assertCurrent?: Parameters<typeof original>[3],
        createAdmission?: Parameters<typeof original>[4],
      ) => {
        let staging = false;
        let admission: SqliteWorkerOperationAdmission | undefined;
        return original(
          target,
          (worker) =>
            operation({
              execute: async (command, options) => {
                staging =
                  command.type === "session.pendingInputs.mutate" &&
                  isRecord(command.input) &&
                  command.input.kind === "stage";
                if (staging) {
                  attempts++;
                  if (outcome === "refused") {
                    throw new Error("Synthetic refusal before native staging");
                  }
                }
                const result = await worker.execute(command, options);
                if (!staging) {
                  return result;
                }
                committed++;
                const owned = expectDefined(admission, "real staging admission");
                expect(owned.committed).toMatchObject({
                  facts: { kind: "pending-input-settlement", operation: "stage" },
                });
                expect(owned.settlement?.kind).toBe("completed");
                if (outcome === "unknown") {
                  const settlement = vi
                    .spyOn(owned, "settlement", "get")
                    .mockReturnValue({ ...owned.settlement, kind: "unknown" });
                  restoreSettlement = () => settlement.mockRestore();
                  throw new Error("Synthetic staging reply lost after native commit");
                }
                return result;
              },
            }),
          stateContext,
          assertCurrent,
          createAdmission &&
            ((retained) => {
              const owned = createAdmission(retained);
              if (staging) {
                admission = owned.admission;
              }
              return owned;
            }),
        );
      },
    );
  return {
    attempts: () => attempts,
    committed: () => committed,
    restore: () => {
      restoreSettlement?.();
      observer.mockRestore();
    },
  };
}

describe("Gateway pending-input media custody", () => {
  const fixture = installAgentAuthorityProofFixture();

  it.for(
    (["agent inline", "agent offloaded", "chat offloaded"] as const).flatMap((route) =>
      (["unknown", "refused", "accepted"] as const).map((outcome) => ({ route, outcome })),
    ),
  )(
    "preserves the $route attachment according to $outcome staging",
    async ({ route, outcome }, { signal }) => {
      const f = await fixture({ imageCapable: true });
      const bytes =
        route === "chat offloaded"
          ? Buffer.from("synthetic inbound attachment")
          : route === "agent offloaded"
            ? Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(2_000_001)])
            : Buffer.from(PNG, "base64");
      const request = {
        message: "retain the attachment with its admitted input",
        attachments: [
          {
            mimeType: route === "chat offloaded" ? "text/plain" : "image/png",
            fileName: route === "chat offloaded" ? "notes.txt" : "image.png",
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
      const staging = observeStaging(outcome);
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
      const send = () =>
        route === "chat offloaded"
          ? dispatchGatewayMethodInProcessRaw(
              "chat.send",
              { ...request, sessionKey: f.sessionKey, idempotencyKey: f.runId },
              {
                forceSyntheticClient: true,
                syntheticScopes: ["operator.admin"],
                resolveGatewayContext: () => f.context,
              },
            )
          : f.dispatch(request, null);
      try {
        const response = await send();
        if (route === "chat offloaded" && outcome === "accepted") {
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
        expect(saved).toHaveLength(1);
        const media = expectDefined(saved[0], "real inbound file");
        const pending = await sessionAccessor.listSessionPendingInputs(f.scope);
        const transcript = sessionAccessor.loadTranscriptEventsSync(f.scope);
        if (outcome === "refused") {
          expect(response).toMatchObject({
            ok: false,
            error: { message: expect.stringContaining("Synthetic refusal before native staging") },
          });
          expect(pending.total).toBe(0);
          expect(transcript).toEqual(f.before);
          await expect(fs.stat(media.path)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(media.path)).toEqual(bytes);
          expect(deleteObserver).not.toHaveBeenCalledWith(media.id, "inbound");
          if (outcome === "unknown") {
            expect(response).toMatchObject({
              ok: false,
              error: { message: expect.stringContaining("commitment is unknown; do not replay") },
            });
            // UNKNOWN never publishes a live input owner. The public history
            // read reconciles that committed, ownerless row to interrupted.
            expect(pending).toMatchObject({
              total: 1,
              items: [{ runId: f.runId, state: "interrupted" }],
            });
            expect(JSON.stringify(pending.items[0]?.message)).toContain(media.id);
            expect(transcript).toEqual(f.before);
          } else {
            expect(response.ok).toBe(true);
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
        expect(agentCommandMock).toHaveBeenCalledTimes(
          outcome === "accepted" && route !== "chat offloaded" ? 1 : 0,
        );
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(
          outcome === "accepted" && route === "chat offloaded" ? 1 : 0,
        );
      } finally {
        try {
          await f.cleanup();
        } finally {
          await Promise.allSettled(deletions);
          staging.restore();
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
