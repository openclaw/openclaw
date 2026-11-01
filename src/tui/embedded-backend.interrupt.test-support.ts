import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../test/helpers/promise.js";
import type { registerEmbeddedFollowupTests } from "./embedded-backend.followup.test-support.js";
import { localSessionEntry, sendMainChat } from "./embedded-backend.test-helpers.js";

type EmbeddedAgentResult = { payloads: Array<{ text: string }>; meta: Record<string, unknown> };
type InterruptTestContext = Pick<
  Parameters<typeof registerEmbeddedFollowupTests>[0],
  "createBackend" | "agentCommandFromIngressMock" | "loadSessionEntryMock"
>;

export function registerEmbeddedInterruptTests({
  createBackend,
  agentCommandFromIngressMock,
  loadSessionEntryMock,
}: InterruptTestContext) {
  it("keeps a head-of-queue interrupt behind the incumbent's held writer settlement", async () => {
    vi.useFakeTimers();
    const incumbent = deferred<EmbeddedAgentResult>();
    const cancelled = vi.fn();
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", cancelled);
        return incumbent.promise;
      })
      .mockResolvedValue({ payloads: [{ text: "selected complete" }], meta: {} });
    loadSessionEntryMock.mockImplementation((sessionKey, opts) =>
      localSessionEntry(sessionKey, opts, {
        cfg: { messages: { queue: { mode: "followup" } } },
        entry: { queueDebounceMs: 0 },
      }),
    );
    const backend = createBackend();
    backend.start();
    try {
      await sendMainChat(backend, "incumbent writer", "head-incumbent");
      await sendMainChat(backend, "retained head input", "head-selected");
      await sendMainChat(backend, "/interrupt head-selected", "head-control");
      // Flush the actual local scheduler, with debounce removed. Cancellation
      // is acknowledged, but the incumbent intentionally still owns its writer.
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(agentCommandFromIngressMock).toHaveBeenCalledOnce();
      incumbent.resolve({ payloads: [{ text: "writer settled" }], meta: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(agentCommandFromIngressMock.mock.calls.map((call) => call[0].runId)).toEqual([
        "head-incumbent",
        "head-selected",
      ]);
      expect(agentCommandFromIngressMock.mock.calls[1]?.[0].message).toBe("retained head input");
    } finally {
      incumbent.resolve({ payloads: [], meta: {} });
      vi.useRealTimers();
      await backend.stop();
    }
  });

  it("promotes an original queued local input without losing siblings or outrunning writer settlement", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const cancelled = vi.fn();
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", cancelled);
        return first.promise;
      })
      .mockResolvedValue({ payloads: [{ text: "completed" }], meta: {} });
    loadSessionEntryMock.mockImplementation((sessionKey, opts) =>
      localSessionEntry(sessionKey, opts, {
        cfg: { messages: { queue: { mode: "followup" } } },
      }),
    );
    const backend = createBackend();
    backend.start();
    try {
      await sendMainChat(backend, "active", "local-active");
      await sendMainChat(backend, "older original", "local-older");
      await sendMainChat(backend, "selected original", "local-selected");
      await sendMainChat(backend, "later original", "local-later");
      await sendMainChat(backend, "/interrupt list", "local-list");
      await sendMainChat(backend, "/interrupt local-selected", "local-control");
      await sendMainChat(backend, "/interrupt local-later", "local-second-control");
      await sendMainChat(backend, "new after control", "local-new");
      expect(cancelled).toHaveBeenCalledOnce();
      expect(agentCommandFromIngressMock).toHaveBeenCalledOnce();
      first.resolve({ payloads: [{ text: "settled" }], meta: {} });
      await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(5));
      expect(agentCommandFromIngressMock.mock.calls.map((call) => call[0].runId)).toEqual([
        "local-active",
        "local-later",
        "local-selected",
        "local-older",
        "local-new",
      ]);
      expect(agentCommandFromIngressMock.mock.calls.map((call) => call[0].message)).toEqual([
        "active",
        "later original",
        "selected original",
        "older original",
        "new after control",
      ]);
      await sendMainChat(backend, "/interrupt local-selected", "local-stale-control");
      await sendMainChat(backend, "/followupmode interrupt", "local-profile-control");
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(5);
    } finally {
      first.resolve({ payloads: [], meta: {} });
      await backend.stop();
    }
  });

  it("keeps existing local queue custody when a new message uses interrupt mode", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const cancelled = vi.fn(() => first.resolve({ payloads: [], meta: {} }));
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", cancelled);
        return first.promise;
      })
      .mockResolvedValue({ payloads: [{ text: "completed" }], meta: {} });
    let mode = "collect" as "collect" | "interrupt";
    loadSessionEntryMock.mockImplementation((sessionKey, opts) =>
      localSessionEntry(sessionKey, opts, {
        cfg: { messages: { queue: { mode } } },
      }),
    );
    const backend = createBackend();
    backend.start();
    try {
      await sendMainChat(backend, "active", "mode-active");
      await sendMainChat(backend, "older", "mode-older");
      await sendMainChat(backend, "later", "mode-later");
      mode = "interrupt";
      await sendMainChat(backend, "replacement", "mode-replacement");
      await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(3));
      expect(cancelled).toHaveBeenCalledOnce();
      expect(agentCommandFromIngressMock.mock.calls[2]?.[0].message).toContain("older");
      expect(agentCommandFromIngressMock.mock.calls[2]?.[0].message).toContain("later");
      expect(agentCommandFromIngressMock.mock.calls.map((call) => call[0].runId)).toEqual([
        "mode-active",
        "mode-replacement",
        "mode-older",
      ]);
    } finally {
      first.resolve({ payloads: [], meta: {} });
      await backend.stop();
    }
  });

  it("interrupts the active local run before starting its replacement", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const firstAbortListener = vi.fn(() => {
      first.resolve({ payloads: [{ text: "first aborted" }], meta: {} });
    });
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", firstAbortListener);
        return first.promise;
      })
      .mockResolvedValueOnce({ payloads: [{ text: "replacement done" }], meta: {} });
    loadSessionEntryMock.mockImplementation((sessionKey, opts) =>
      localSessionEntry(sessionKey, opts, {
        cfg: { messages: { queue: { mode: "interrupt" } } },
      }),
    );

    const backend = createBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");
    await sendMainChat(backend, "replace it", "run-local-second");

    expect(firstAbortListener).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    });
  });
}
