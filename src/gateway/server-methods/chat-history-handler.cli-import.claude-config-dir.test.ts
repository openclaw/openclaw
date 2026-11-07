import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  NATIVE_HISTORY_AUTHORIZATION_REQUEST,
  isNativeHistoryAuthorizationRequest,
} from "../../config/sessions/session-history-types.js";
import * as sessionHistoryWorkerRuntime from "../../config/sessions/session-history-worker-runtime.js";
import * as sessionTranscriptWorkerRuntime from "../../config/sessions/session-transcript-worker-runtime.js";
import { SerializedJsonArray } from "../serialized-json.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import {
  messageReader,
  withImportedHistory,
} from "./chat-history-handler.cli-import.test-support.js";
import * as historyPages from "./chat-history-pages.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Revoke the current profile from inside the first native authorization roundtrip. */
function revokeOnFirstAuthorization(incognito: boolean, revoke: () => void) {
  const runProcessHeldHistoryTask = sessionTranscriptWorkerRuntime.runProcessHeldHistoryTask;
  const workerRead = sessionHistoryWorkerRuntime.readSessionHistoryPageInWorker;
  const worker = vi.spyOn(sessionHistoryWorkerRuntime, "readSessionHistoryPageInWorker");
  const heldTask = vi.spyOn(sessionTranscriptWorkerRuntime, "runProcessHeldHistoryTask");
  const counter = { nativeAuthorizationRequests: 0 };
  if (incognito) {
    heldTask.mockImplementationOnce(async (history, onRequest, signal) =>
      runProcessHeldHistoryTask(
        history,
        async (value, requestContext) => {
          if (isNativeHistoryAuthorizationRequest(value)) {
            counter.nativeAuthorizationRequests += 1;
            revoke();
          }
          return onRequest(value, requestContext);
        },
        signal,
      ),
    );
  } else {
    worker.mockImplementationOnce(async (...args) => {
      const [request, signal, onRequest] = args;
      return workerRead(request, signal, async (value) => {
        expect(value).toEqual(NATIVE_HISTORY_AUTHORIZATION_REQUEST);
        counter.nativeAuthorizationRequests += 1;
        revoke();
        await onRequest?.(value, signal ?? new AbortController().signal);
      });
    });
  }
  return { worker, heldTask, counter };
}

describe("CLI-imported history under a selected Claude configuration directory", () => {
  it.each([false, true])(
    "rechecks native message authority and retains canonical access (incognito: %s)",
    async (incognito) => {
      await withImportedHistory(
        1,
        "native-only message",
        async ({ scope, sourcePath, importedIds, append }) => {
          await upsertSessionEntryCore(scope, {
            cliSessionBindings: {
              "claude-cli": {
                sessionId: path.basename(sourcePath, ".jsonl"),
                transcriptRoot: path.dirname(path.dirname(sourcePath)),
              },
            },
          });
          const canonical = await append("assistant", "Canonical-only message");
          const getMessage = await messageReader(scope.sessionKey);
          const retainAuthorization = vi.fn<(isCurrent: () => boolean) => void>();
          const readMessage = historyPages.readChatHistoryMessageById;
          vi.spyOn(historyPages, "readChatHistoryMessageById").mockImplementationOnce(
            (input, retain) =>
              readMessage(input, (isCurrent) => {
                retainAuthorization(isCurrent);
                retain?.(isCurrent);
              }),
          );
          const nativeId = expectDefined(importedIds[0], "native message ID");
          expect(await getMessage(nativeId)).toMatchObject({
            ok: true,
            message: { content: "Imported 0: native-only message" },
          });
          expect(retainAuthorization).toHaveBeenCalledOnce();
          expect(retainAuthorization.mock.calls[0]?.[0]()).toBe(true);
          const { worker, heldTask, counter } = revokeOnFirstAuthorization(incognito, () =>
            vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(path.dirname(sourcePath), "new-profile")),
          );
          expect(await getMessage(nativeId)).toEqual({ ok: false, unavailableReason: "not_found" });
          expect(counter.nativeAuthorizationRequests).toBe(1);
          if (!incognito) {
            expect(heldTask).not.toHaveBeenCalled();
          }
          worker.mockClear();
          heldTask.mockClear();
          expect(await getMessage(nativeId)).toEqual({ ok: false, unavailableReason: "not_found" });
          expect(await getMessage(canonical.messageId)).toMatchObject({
            ok: true,
            message: { content: "Canonical-only message" },
          });
          expect(
            worker.mock.calls.filter(([request]) => request.kind === "rpc-message"),
          ).toHaveLength(0);
        },
        incognito,
      );
    },
  );

  it.each([false, true])(
    "fails closed at the native-history worker boundary (incognito: %s)",
    async (incognito) => {
      await withImportedHistory(
        1,
        "revoked imported response",
        async ({ read, sourcePath, importedIds }) => {
          const { counter } = revokeOnFirstAuthorization(incognito, () =>
            vi.stubEnv(
              "CLAUDE_CONFIG_DIR",
              path.join(path.dirname(path.dirname(path.dirname(sourcePath))), "changed-claude"),
            ),
          );
          const page = await read({ limit: 10 });
          const messages =
            page.messages instanceof SerializedJsonArray
              ? page.messages.materialize()
              : page.messages;
          expect(counter.nativeAuthorizationRequests).toBe(1);
          expect(messages.map(readChatHistoryMessageId)).not.toContain(importedIds[0]);
          expect(JSON.stringify(messages)).toContain("Local answer");
          expect(JSON.stringify(messages)).not.toContain("revoked imported response");
        },
        incognito,
      );
    },
  );

  it("rejects unknown process-held history host requests", async () => {
    await withImportedHistory(
      1,
      "protocol",
      async ({ read }) => {
        const task = vi
          .spyOn(sessionTranscriptWorkerRuntime, "runProcessHeldHistoryTask")
          .mockImplementationOnce(async (_history, onRequest) => {
            const controller = new AbortController();
            await expect(
              onRequest(
                { kind: "unknown", options: {} },
                { signal: controller.signal, yieldSignal: controller.signal },
              ),
            ).rejects.toThrow("Unsupported process-held history request");
            throw new Error("process-held protocol rejection");
          });
        await expect(read({ limit: 1 })).rejects.toThrow("process-held protocol rejection");
        expect(task).toHaveBeenCalledTimes(1);
      },
      true,
    );
  });
});
