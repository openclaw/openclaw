import { expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import { runDispatch } from "./dispatch-acp.test-support.js";
import {
  createAcpTestConfig,
  createAcpTestReplyDispatcherFixture as createDispatcher,
} from "./test-fixtures/acp-runtime.js";

interface AcpMediaPreprocessingHarness {
  mediaUnderstandingMocks: {
    applyMediaUnderstanding: Mock<
      (params: unknown) => Promise<ApplyMediaUnderstandingResult | undefined>
    >;
  };
  managerMocks: { runTurn: unknown };
  auditMocks: { emitAcpLifecycleError: unknown };
  routeMocks: { routeReply: unknown };
  transcriptMocks: { persistAcpDispatchTranscript: unknown };
  runTurnCall: () => Record<string, unknown>;
  requireRecord: (value: unknown, label: string) => Record<string, unknown>;
}

export function registerAcpMediaPreprocessingTests(harness: AcpMediaPreprocessingHarness): void {
  const {
    mediaUnderstandingMocks,
    managerMocks,
    auditMocks,
    routeMocks,
    transcriptMocks,
    runTurnCall,
    requireRecord,
  } = harness;
  it("passes the ACP agent directory without declaring host-path access", async () => {
    const agentDir = "/tmp/acp-agent";
    await runDispatch({
      bodyForAgent: "describe image",
      cfg: createAcpTestConfig({
        agents: { entries: { "codex-acp": { agentDir } } },
        channels: { imessage: { attachmentRoots: ["/tmp/acp-inbound"] } },
      }),
      ctxOverrides: {
        Provider: "imessage",
        Surface: "imessage",
        MediaPath: "/tmp/acp-inbound/image.png",
        MediaType: "image/png",
      },
    });
    const input = requireRecord(
      mediaUnderstandingMocks.applyMediaUnderstanding.mock.calls[0]?.[0],
      "media understanding",
    );
    expect(input.agentDir).toBe(agentDir);
    expect(input.selfServeLocalPaths).toBeUndefined();
  });

  it("keeps the ACP raw-media fallback for an ordinary understanding failure", async () => {
    mediaUnderstandingMocks.applyMediaUnderstanding.mockRejectedValueOnce(
      new Error("transcription provider unavailable"),
    );
    await runDispatch({
      bodyForAgent: "transcribe this recording",
      ctxOverrides: { media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }] },
    });
    expect(runTurnCall().text).toContain("transcribe this recording");
    expect(auditMocks.emitAcpLifecycleError).not.toHaveBeenCalled();
  });

  it.each(["cooperative", "late success"] as const)(
    "cancels media preprocessing without starting ACP or delivering an error (%s)",
    async (completion) => {
      const controller = new AbortController();
      const started = createDeferred();
      const release = createDeferred();
      let cancelled = false;
      mediaUnderstandingMocks.applyMediaUnderstanding.mockImplementationOnce(async (params) => {
        const { signal } = params as { signal?: AbortSignal };
        const onAbort = () => {
          cancelled = true;
          release.resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        started.resolve();
        try {
          await release.promise;
          if (completion === "cooperative") {
            signal?.throwIfAborted();
          }
          return { extractedFileImages: [] };
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      });
      const { dispatcher } = createDispatcher();
      const markIdle = vi.fn();
      const recordProcessed = vi.fn();
      const dispatch = runDispatch({
        bodyForAgent: "transcribe this recording",
        abortSignal: controller.signal,
        dispatcher,
        markIdle,
        recordProcessed,
        ctxOverrides: {
          media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
        },
      });
      try {
        await awaitGateBeforeSettlement(
          started.promise,
          dispatch,
          "ACP media preprocessing did not start",
        );
        controller.abort(new Error("media request cancelled"));
        expect.soft(cancelled).toBe(true);
        release.resolve();
        await expect(dispatch).resolves.toMatchObject({ queuedFinal: false });
        expect.soft(managerMocks.runTurn).not.toHaveBeenCalled();
        expect.soft(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        expect.soft(routeMocks.routeReply).not.toHaveBeenCalled();
        expect.soft(transcriptMocks.persistAcpDispatchTranscript).not.toHaveBeenCalled();
        expect.soft(auditMocks.emitAcpLifecycleError).not.toHaveBeenCalled();
        expect.soft(recordProcessed).toHaveBeenCalledWith("completed", { reason: "acp_aborted" });
        expect.soft(markIdle).toHaveBeenCalledWith("message_aborted");
      } finally {
        release.resolve();
        await dispatch;
      }
    },
  );
}
