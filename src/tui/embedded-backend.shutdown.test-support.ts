import { expect, it, vi, type Mock } from "vitest";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { defaultRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";
import { captureBackendEvents } from "./embedded-backend.stream.test-support.js";
import { deferred, flushMicrotasks, sendMainChat } from "./embedded-backend.test-helpers.js";

type EmbeddedAgentResult = {
  payloads: Array<{ text: string }>;
  meta: Record<string, unknown>;
};

export function registerEmbeddedBackendShutdownTests({
  createBackend,
  agentCommandFromIngressMock,
  getRegisteredListener,
  originalRuntimeLog,
  originalRuntimeError,
}: {
  createBackend: () => EmbeddedTuiBackend;
  agentCommandFromIngressMock: Mock;
  getRegisteredListener: () => ((event: unknown) => void) | undefined;
  originalRuntimeLog: typeof defaultRuntime.log;
  originalRuntimeError: typeof defaultRuntime.error;
}) {
  it("waits for local post-turn maintenance before emitting chat final", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = createBackend();
    const events = captureBackendEvents(backend);

    backend.start();
    await sendMainChat(backend, "compact after final", "run-local-maintenance");

    getRegisteredListener()?.({
      runId: "run-local-maintenance",
      stream: "assistant",
      data: { text: "done", delta: "done" },
    });
    getRegisteredListener()?.({
      runId: "run-local-maintenance",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });
    await flushMicrotasks();

    expect(
      events.some(
        (entry) =>
          entry.event === "chat" && (entry.payload as { state?: string }).state === "final",
      ),
    ).toBe(false);

    pending.resolve({ payloads: [{ text: "done" }], meta: {} });
    await flushMicrotasks();

    expect(
      events
        .filter((entry) => entry.event === "chat")
        .map((entry) => (entry.payload as { state?: string }).state),
    ).toEqual(["delta", "final"]);
  });

  it("rejects a send paused in session lookup when shutdown begins", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const firstStarted = deferred<void>();
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal: AbortSignal }) => {
      opts.abortSignal.addEventListener("abort", () => first.resolve({ payloads: [], meta: {} }));
      firstStarted.resolve();
      return first.promise;
    });
    const backend = createBackend();
    backend.start();
    await sendMainChat(backend, "first turn", "shutdown-first");
    await firstStarted.promise;

    const worker = await import("../gateway/session-utils-store-worker.js");
    const readEntry = worker.loadGatewaySessionEntryReadOnlyInWorker;
    const lookupStarted = deferred<void>();
    const releaseLookup = deferred<void>();
    const lookup = vi
      .spyOn(worker, "loadGatewaySessionEntryReadOnlyInWorker")
      .mockImplementationOnce(async (opts) => {
        lookupStarted.resolve();
        await releaseLookup.promise;
        return readEntry(opts);
      });
    try {
      const sending = sendMainChat(backend, "second turn", "shutdown-second");
      await lookupStarted.promise;
      await backend.stop();
      releaseLookup.resolve();
      await expect(sending).rejects.toMatchObject({ name: "AbortError" });
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseLookup.resolve();
      lookup.mockRestore();
    }
  });

  it("waits for local post-turn maintenance during stop", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    const abortListener = vi.fn();
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      opts.abortSignal?.addEventListener("abort", abortListener);
      return pending.promise;
    });

    const backend = createBackend();
    captureBackendEvents(backend);
    backend.start();
    expect(isEmbeddedMode()).toBe(true);
    expect(defaultRuntime.log).not.toBe(originalRuntimeLog);
    expect(defaultRuntime.error).not.toBe(originalRuntimeError);
    await sendMainChat(backend, "compact before shutdown", "run-local-stop-maintenance");

    getRegisteredListener()?.({
      runId: "run-local-stop-maintenance",
      stream: "assistant",
      data: { text: "done", delta: "done" },
    });
    getRegisteredListener()?.({
      runId: "run-local-stop-maintenance",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    let stopped = false;
    const stopPromise = backend.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();

    expect(stopped).toBe(false);
    expect(abortListener).not.toHaveBeenCalled();
    expect(isEmbeddedMode()).toBe(true);

    pending.resolve({ payloads: [{ text: "done" }], meta: {} });
    await stopPromise;

    expect(abortListener).not.toHaveBeenCalled();
    expect(getRegisteredListener()).toBeUndefined();
    expect(isEmbeddedMode()).toBe(false);
    expect(defaultRuntime.log).toBe(originalRuntimeLog);
    expect(defaultRuntime.error).toBe(originalRuntimeError);
  });

  it("aborts local post-turn maintenance when stop grace elapses", async () => {
    await withEnvAsync({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "5" }, async () => {
      const pending = deferred<EmbeddedAgentResult>();
      const abortListener = vi.fn();
      agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", abortListener);
        return pending.promise;
      });

      const backend = createBackend();
      backend.start();
      await sendMainChat(backend, "compact before shutdown", "run-local-stop-timeout");

      getRegisteredListener()?.({
        runId: "run-local-stop-timeout",
        stream: "lifecycle",
        data: { phase: "end", stopReason: "stop" },
      });

      let stopped = false;
      const stopPromise = backend.stop().then(() => {
        stopped = true;
      });
      await flushMicrotasks();
      expect(stopped).toBe(false);
      expect(abortListener).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5);
      expect(abortListener).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(false);
      expect(isEmbeddedMode()).toBe(true);

      // Cancellation does not own settlement: keep the runtime available for
      // the aborted turn's final cleanup before releasing embedded ownership.
      pending.resolve({ payloads: [], meta: { aborted: true } });
      await stopPromise;
      expect(isEmbeddedMode()).toBe(false);
    });
  });
}
