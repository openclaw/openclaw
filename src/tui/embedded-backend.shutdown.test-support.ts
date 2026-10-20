import { expect, it, vi, type Mock } from "vitest";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { defaultRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";
import { captureBackendEvents } from "./embedded-backend.stream.test-support.js";
import { deferred, flushMicrotasks, sendMainChat } from "./embedded-backend.test-helpers.js";

type EmbeddedAgentResult = { payloads: Array<{ text: string }>; meta: Record<string, unknown> };

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
  async function startMaintenance(withText = true) {
    const pending = deferred<EmbeddedAgentResult>();
    const abortListener = vi.fn();
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      opts.abortSignal?.addEventListener("abort", abortListener);
      return pending.promise;
    });
    const backend = createBackend();
    const events = captureBackendEvents(backend);
    backend.start();
    expect(isEmbeddedMode()).toBe(true);
    expect(defaultRuntime.log).not.toBe(originalRuntimeLog);
    expect(defaultRuntime.error).not.toBe(originalRuntimeError);
    await sendMainChat(backend, "compact before shutdown", "maintenance");
    if (withText) {
      getRegisteredListener()?.({
        runId: "maintenance",
        stream: "assistant",
        data: { text: "done", delta: "done" },
      });
    }
    getRegisteredListener()?.({
      runId: "maintenance",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });
    const chatStates = () =>
      events.filter((e) => e.event === "chat").map((e) => (e.payload as { state?: string }).state);
    return { backend, pending, abortListener, chatStates };
  }

  it("waits for local post-turn maintenance before emitting chat final", async () => {
    const { pending, chatStates } = await startMaintenance();
    await flushMicrotasks();
    expect(chatStates()).not.toContain("final");
    pending.resolve({ payloads: [{ text: "done" }], meta: {} });
    await flushMicrotasks();
    expect(chatStates()).toEqual(["delta", "final"]);
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

  it.each([false, true])("joins maintenance during stop (grace expired: %s)", async (expired) => {
    await withEnvAsync(
      expired ? { OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "5" } : {},
      async () => {
        const { pending, abortListener, backend } = await startMaintenance(!expired);
        const stopped = vi.fn();
        const stopPromise = backend.stop().then(stopped);
        await flushMicrotasks();
        expect(stopped).not.toHaveBeenCalled();
        expect(abortListener).not.toHaveBeenCalled();
        if (expired) {
          await vi.advanceTimersByTimeAsync(5);
          expect(abortListener).toHaveBeenCalledTimes(1);
          expect(stopped).not.toHaveBeenCalled();
        }
        expect(isEmbeddedMode()).toBe(true);
        // Abort does not settle maintenance or release embedded runtime ownership.
        pending.resolve({
          payloads: expired ? [] : [{ text: "done" }],
          meta: expired ? { aborted: true } : {},
        });
        await stopPromise;
        if (!expired) {
          expect(abortListener).not.toHaveBeenCalled();
        }
        expect(getRegisteredListener()).toBeUndefined();
        expect(isEmbeddedMode()).toBe(false);
        expect(defaultRuntime.log).toBe(originalRuntimeLog);
        expect(defaultRuntime.error).toBe(originalRuntimeError);
      },
    );
  });
}
