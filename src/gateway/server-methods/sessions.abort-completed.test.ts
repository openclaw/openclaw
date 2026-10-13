// Preserve registry fixtures before the cancellation entrypoint loads.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi, type MockInstance } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { removeChatAbortControllerEntry } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import * as sessionUtils from "../session-utils.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

useChatAbortRegistryFixture();

it.each([
  "completed",
  "metadata",
  "pending metadata",
  "pending run",
  "pending session",
  "controller",
  "session",
] as const)("native same-device Stop handles %s during metadata preparation", async (change) => {
  const sessionKey = "agent:main:native-completion";
  const sessionId = "native-completion-session";
  const scope = { agentId: "main", sessionKey };
  const entry = { sessionId, updatedAt: 1 };
  await replaceSessionEntry(scope, entry);
  const context = createDirectChatContext({ getRuntimeConfig });
  const original = createActiveRun(sessionKey, {
    sessionId,
    agentId: "main",
    owner: { connId: "original-connection", deviceId: "same-device" },
  });
  const successor = createActiveRun(sessionKey, { sessionId, agentId: "main" });
  context.chatAbortControllers.set("run", original);
  const entered = createDeferred();
  const resume = createDeferred();
  const publicationEntered = createDeferred();
  const publish = createDeferred();
  let updating: Promise<unknown> | undefined;
  let publication: MockInstance<typeof workerStore.runSqliteWorkerStoreOperation> | undefined;
  const pending = change.startsWith("pending ");
  const changedSession = change === "session" || change === "pending session";
  const aborts = change === "metadata" || change === "pending metadata";
  const read = sessionUtils.loadGatewaySessionEntryReadOnlyInWorker;
  const metadata = vi
    .spyOn(sessionUtils, "loadGatewaySessionEntryReadOnlyInWorker")
    .mockImplementationOnce(async (params) => {
      const snapshot = await read(params);
      entered.resolve();
      await resume.promise;
      return snapshot;
    });
  const respond = vi.fn();
  const stopping = handleGatewayRequest({
    req: {
      type: "req",
      id: "native-stop",
      method: "sessions.abort",
      params: { key: sessionKey, runId: "run" },
    },
    context,
    client: {
      ...sharingPolicyClient({ deviceId: "same-device", scopes: ["operator.write"] }),
      connId: "stop-connection",
    },
    respond,
    isWebchatConnect: () => false,
    extraHandlers: sessionAbortHandlers,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await awaitGateBeforeSettlement(entered.promise, stopping, "Stop skipped metadata read");
    if (change === "metadata" || pending || changedSession) {
      if (pending) {
        const run = workerStore.runSqliteWorkerStoreOperation;
        let held = false;
        publication = vi
          .spyOn(workerStore, "runSqliteWorkerStoreOperation")
          .mockImplementation(
            <Operations extends SqliteWorkerOperations, T>(
              target: SqliteWorkerStore<Operations>,
              operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
              stateContext?: Parameters<typeof run>[2],
              assertCurrent?: Parameters<typeof run>[3],
              createAdmission?: Parameters<typeof run>[4],
            ) => {
              let replacing = false;
              return run(
                target,
                (worker) =>
                  operation({
                    execute: (command, options) => {
                      replacing = command.type === "session.entry.patch.commit";
                      return worker.execute(command, options);
                    },
                  }),
                stateContext,
                assertCurrent,
                createAdmission &&
                  ((retained) => {
                    if (!replacing || held) {
                      return createAdmission(retained);
                    }
                    held = true;
                    return createAdmission({
                      settled: retained.settled.then(async (outcome) => {
                        expect(outcome.kind).toBe("completed");
                        publicationEntered.resolve();
                        await publish.promise;
                        return outcome;
                      }),
                    });
                  }),
              );
            },
          );
      }
      updating = replaceSessionEntry(scope, {
        ...entry,
        updatedAt: 2,
        ...(changedSession
          ? { sessionId: "replacement-session" }
          : pending
            ? {
                lifecycleRunId: change === "pending run" ? "replacement-run" : "run",
                activeWriterRunId: change === "pending run" ? "replacement-run" : "run",
              }
            : { label: "Renamed" }),
      });
      if (pending) {
        await awaitGateBeforeSettlement(
          publicationEntered.promise,
          updating,
          "Write skipped native settlement",
        );
      } else {
        await updating;
      }
    } else {
      expect(removeChatAbortControllerEntry(context.chatAbortControllers, "run", original)).toBe(
        true,
      );
      if (change === "controller") {
        context.chatAbortControllers.set("run", successor);
      }
    }
    resume.resolve();
    const error = await stopping;
    if (change === "controller") {
      expect(error).toMatchObject({ message: "Run changed before cancellation; retry Stop." });
      expect(respond).not.toHaveBeenCalled();
    } else if (changedSession || change === "pending run") {
      expect(error).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          details: expect.objectContaining({ code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" }),
        }),
      );
    } else {
      expect(error).toBeUndefined();
      expect(respond.mock.calls[0]?.slice(0, 2), JSON.stringify(respond.mock.calls[0])).toEqual([
        true,
        {
          ok: true,
          abortedRunId: aborts ? "run" : null,
          status: aborts ? "aborted" : "no-active-run",
        },
      ]);
    }
    expect(original.controller.signal.aborted).toBe(aborts);
    expect(successor.controller.signal.aborted).toBe(false);
  } finally {
    resume.resolve();
    publish.resolve();
    try {
      await stopping;
      await updating;
    } finally {
      publication?.mockRestore();
      metadata.mockRestore();
    }
  }
});
