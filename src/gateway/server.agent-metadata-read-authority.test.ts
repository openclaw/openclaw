import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sessionMeta from "../acp/runtime/session-meta.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { isMissingPathError } from "../infra/errors.js";
import { ATTACHMENT_OFFLOAD_THRESHOLD_BYTES } from "../media/attachment-processor.runtime.js";
import { encodePngRgb } from "../media/png-encode.js";
import * as mediaStore from "../media/store.js";
import { createAgentDedupeLifecycle } from "./agent-turn/agent-dedupe-lifecycle.js";
import {
  holdExecution,
  installAgentAuthorityProofFixture,
  reach,
  type Response,
} from "./server.agent-runtime-authority-proof.test-support.js";
import { loadSessionEntry } from "./session-utils.js";
import { agentCommandMock } from "./test-helpers.js";

async function inboundMediaFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(mediaStore.getMediaDir(), "inbound"))).sort();
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

describe("agent RPC metadata-read authority", () => {
  const fixture = installAgentAuthorityProofFixture();

  it.for(["live", "stopped", "replaced"] as const)(
    "retains the request through joined metadata before media effects: %s",
    async (mode, { signal }) => {
      const f = await fixture({ imageCapable: true });
      const execution = await holdExecution(signal);
      // Incompressible pixels exercise the real parser's offload write before admission.
      const image = encodePngRgb(randomBytes(1024 * 1024 * 3), 1024, 1024);
      expect(image.byteLength).toBeGreaterThan(ATTACHMENT_OFFLOAD_THRESHOLD_BYTES);
      expect(image.byteLength).toBeLessThan(MAX_IMAGE_BYTES);
      const beforeEntry = loadSessionEntry(f.sessionKey, { agentId: "main" }).entry;
      const beforeMedia = await inboundMediaFiles();
      const entered =
        createDeferred<Awaited<ReturnType<typeof sessionMeta.readAcpSessionEntryAsync>>>();
      const release = createDeferred();
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      if (signal.aborted) {
        unblock();
      }
      const read = sessionMeta.readAcpSessionEntryAsync;
      let held = false;
      const readObserver = vi
        .spyOn(sessionMeta, "readAcpSessionEntryAsync")
        .mockImplementation(async (input) => {
          const result = await read(input);
          if (input.sessionKey === f.sessionKey && !held) {
            held = true;
            entered.resolve(result);
            await release.promise;
          }
          return result;
        });
      const save = mediaStore.saveMediaBuffer;
      const saved: mediaStore.SavedMedia[] = [];
      const writeObserver = vi
        .spyOn(mediaStore, "saveMediaBuffer")
        .mockImplementation(async (...args) => {
          const result = await save(...args);
          saved.push(result);
          return result;
        });
      const params = {
        message: "Inspect this synthetic offloaded image",
        attachments: [
          {
            mimeType: "image/png",
            fileName: "metadata-proof.png",
            content: image.toString("base64"),
          },
        ],
      };
      let request: Promise<Response> | undefined;
      let replacement: ReturnType<typeof createAgentDedupeLifecycle> | undefined;
      try {
        request = f.dispatch(params);
        // Keep observing effects when the broken continuation rejects before an RPC response.
        const outcome = request.then(
          (response) => ({ kind: "fulfilled" as const, response }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        const joined = await reach(entered.promise, request);
        expect(joined?.entry?.sessionId).toBe(f.sessionId);
        expect(f.context.dedupe.get(`agent:${f.runId}`)?.payload).toMatchObject({
          runId: f.runId,
          sessionKey: f.sessionKey,
          status: "accepted",
        });
        expect(f.context.chatAbortControllers.has(f.runId)).toBe(false);
        expect(saved).toEqual([]);
        if (mode === "stopped") {
          expect(await f.stop()).toMatchObject({ ok: true, payload: { aborted: true } });
        } else if (mode === "replaced") {
          replacement = createAgentDedupeLifecycle({
            cfg: f.context.getRuntimeConfig(),
            request: { message: params.message, idempotencyKey: f.runId },
            runId: f.runId,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            agentDedupeKeys: [`agent:${f.runId}`],
            suppressVisibleSessionEffects: false,
            context: f.context,
            io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
          });
          replacement.reserve(f.sessionKey, "main");
        }
        const retained = f.context.dedupe.get(`agent:${f.runId}`);
        release.resolve();
        const result = await outcome;
        if (mode === "live") {
          expect(result).toMatchObject({
            kind: "fulfilled",
            response: { ok: true, payload: { status: "accepted" } },
          });
          const prepared = await execution.entered;
          expect(saved).toHaveLength(1);
          const stored = expectDefined(saved[0], "persisted offloaded image");
          expect(await fs.readFile(stored.path)).toEqual(image);
          const recorder = expectDefined(prepared.userTurn.recorder, "admitted user-turn recorder");
          const withPendingInput = expectDefined(recorder.withPendingInput, "pending-input owner");
          const persisted = await withPendingInput(() => recorder.persistApproved());
          expect(persisted?.appended).toBe(true);
          expect(JSON.stringify(sessionAccessor.loadTranscriptEventsSync(f.scope))).toContain(
            stored.id,
          );
          expect(await fs.readFile(stored.path)).toEqual(image);
        } else {
          // Both observations matter: cleanup must not conceal an unauthorized write.
          expect.soft(writeObserver).not.toHaveBeenCalled();
          expect.soft(saved).toEqual([]);
          expect.soft(await inboundMediaFiles()).toEqual(beforeMedia);
          expect
            .soft(loadSessionEntry(f.sessionKey, { agentId: "main" }).entry)
            .toEqual(beforeEntry);
          expect.soft(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(f.before);
          expect.soft(listSessionPendingInputs(f.scope).total).toBe(0);
          expect.soft(execution.observer).not.toHaveBeenCalled();
          expect.soft(agentCommandMock).not.toHaveBeenCalled();
          expect.soft(f.context.chatAbortControllers.has(f.runId)).toBe(false);
          expect.soft(f.context.dedupe.get(`agent:${f.runId}`)).toBe(retained);
          const response = {
            ok: true,
            meta: { cached: true },
            payload: {
              status: mode === "stopped" ? "timeout" : "in_flight",
              ...(mode === "stopped" ? { stopReason: "rpc" } : {}),
            },
          };
          expect.soft(result).toMatchObject({ kind: "fulfilled", response });
          const retry = await f.dispatch(params).then(
            (value) => ({ kind: "fulfilled" as const, response: value }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          );
          expect.soft(retry).toMatchObject({ kind: "fulfilled", response });
          expect.soft(f.context.dedupe.get(`agent:${f.runId}`)).toBe(retained);
          expect.soft(writeObserver).not.toHaveBeenCalled();
          expect.soft(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(f.before);
          expect.soft(listSessionPendingInputs(f.scope).total).toBe(0);
        }
      } finally {
        release.resolve();
        await execution.cleanup();
        await Promise.allSettled([request]);
        replacement?.clearUnaccepted();
        await f.cleanup();
        writeObserver.mockRestore();
        readObserver.mockRestore();
        signal.removeEventListener("abort", unblock);
      }
    },
  );
});
