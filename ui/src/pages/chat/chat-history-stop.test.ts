// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { t } from "../../i18n/index.ts";
import { dispatchChatSlashCommand } from "./chat-commands.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { beginHistoryRequest, getChatHistoryLoadState } from "./chat-history-state.ts";
import { prepareChatHistoryPacket } from "./chat-history-window.ts";
import {
  createState,
  historyMessage as message,
  publishLive,
  type TestState,
} from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjection,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import { beginChatScrollIntent, cancelChatScroll } from "./scroll.ts";

const CHAT_RESIDENT_WEIGHT_TARGET = 3 * 1024 * 1024;

describe("full tail after a long live turn", () => {
  const prompt = message("user", "opening prompt", { id: "prompt", seq: 1 });
  const call = (seq: number) => message("assistant", `call ${seq}`, { id: `call-${seq}`, seq });
  const result = (seq: number) => ({
    role: "toolResult",
    content: [{ type: "text", text: `result ${seq}` }],
    __openclaw: { id: `result-${seq}`, seq },
  });
  const transcript = [prompt, call(2), result(3), call(4), result(5), call(6), call(7)];
  const sessionInfo = { key: "main", kind: "direct" as const, updatedAt: 1, sessionId: "session" };
  const tailFrom = (start: number, totalMessages = transcript.length) => ({
    messages: transcript.slice(start),
    hasMore: true,
    olderCursor: "older:tail",
    nextOffset: transcript.length - start,
    totalMessages,
    sessionInfo: { ...sessionInfo, hasActiveRun: false, status: "killed" as const },
  });

  const gapPacket = (): ChatHistoryResult => ({
    messages: transcript.slice(2, 4),
    hasMore: true,
    olderCursor: "older:head",
    nextOffset: 5,
    totalMessages: 7,
    sessionInfo,
  });

  async function loadAfterLiveTurn(
    tail: ChatHistoryResult,
    older: (cursor: string) => Promise<ChatHistoryResult>,
    {
      cursorReset = true,
      initialEnd = 1,
      previousLeaf,
      captureState,
      beforeRefresh,
      supersedeFallback = false,
    }: {
      cursorReset?: boolean;
      initialEnd?: number;
      previousLeaf?: string;
      captureState?: (state: TestState) => void;
      beforeRefresh?: (state: TestState) => void;
      supersedeFallback?: boolean;
    } = {},
  ) {
    const state = createState(tail);
    state.currentSessionId = "session";
    state.chatDisplayedLeafEntryId = undefined;
    captureState?.(state);
    const pages: ChatHistoryResult[] = [
      {
        messages: transcript.slice(0, initialEnd),
        totalMessages: initialEnd,
        deltaCursor: "before-stop",
        sessionInfo: { ...sessionInfo, hasActiveRun: true, activeLeafEntryId: previousLeaf },
      },
      tail,
      ...(supersedeFallback ? [tail] : []),
    ];
    const fallbackStarted = createDeferred();
    const fallbackResponse = createDeferred<ChatHistoryResult>();
    let deferFallback = supersedeFallback;
    const request = vi
      .spyOn(state.client!, "request")
      .mockImplementation(async (_method, params) => {
        const cursor = (params as { cursor?: string }).cursor;
        if (cursor?.startsWith("older:")) {
          return older(cursor);
        }
        // Stop persists an aborted reply, so the delta cursor resets to a bounded tail.
        if (cursor === "before-stop" && cursorReset) {
          return { kind: "reset" };
        }
        const page = pages.shift();
        if (deferFallback && page === tail) {
          deferFallback = false;
          fallbackStarted.resolve();
          return fallbackResponse.promise;
        }
        return page;
      });
    await loadChatHistory(state);
    // Live rows carry assistant turns only; tool results arrive as activity.
    const scope = {
      sessionKey: state.sessionKey,
      sessionId: "session",
      activeLeafEntryId: previousLeaf ?? null,
    };
    for (const row of [call(2), call(4), call(6)]) {
      publishLive(state, row, scope);
    }
    beforeRefresh?.(state);
    const loading = loadChatHistory(state);
    if (supersedeFallback) {
      await fallbackStarted.promise;
      const refreshed = loadChatHistory(state, { supersedeInFlight: true });
      fallbackResponse.resolve(tail);
      await refreshed;
    }
    await loading;
    return { state, request };
  }

  it.each([
    ["after a row the pane never held", 2],
    ["at a row the pane held live", 3],
  ])("reads the gap when the tail starts %s", async (_case, start) => {
    const { state, request } = await loadAfterLiveTurn(tailFrom(start), async () => ({
      messages: transcript.slice(0, start),
      totalMessages: transcript.length,
      sessionInfo,
    }));
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ cursor: "before-stop" }),
      expect.anything(),
    );
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ cursor: "older:tail" }),
      expect.anything(),
    );
    expect(state.chatMessages).toEqual(transcript);
    const { segments, ...edges } = state.chatHistoryPagination;
    expect(edges).toEqual({ hasMore: false, totalMessages: 7 });
    expect(segments).toHaveLength(2);
    expect(segments?.every((packet) => packet.boundedPacket)).toBe(true);
  });

  it("restores the held prefix when Stop advances the leaf within the prior read", async () => {
    const tail = tailFrom(2);
    const older = vi.fn(async () => ({ messages: transcript.slice(0, 2), sessionInfo }));
    const { state } = await loadAfterLiveTurn(
      { ...tail, sessionInfo: { ...tail.sessionInfo, activeLeafEntryId: "stopped-leaf" } },
      older,
      { initialEnd: 4, previousLeaf: "running-leaf" },
    );
    expect(state.chatMessages).toEqual(transcript);
    expect(older).toHaveBeenCalledOnce();
    const { segments, ...edges } = state.chatHistoryPagination;
    expect(edges).toEqual({ hasMore: false, totalMessages: 7 });
    expect(segments).toHaveLength(2);
  });

  it("restores the held prefix when a refresh supersedes the Stop fallback", async () => {
    const tail = tailFrom(2);
    const older = vi.fn(async () => ({ messages: transcript.slice(0, 2), sessionInfo }));
    const { state } = await loadAfterLiveTurn(
      { ...tail, sessionInfo: { ...tail.sessionInfo, activeLeafEntryId: "stopped-leaf" } },
      older,
      { initialEnd: 4, previousLeaf: "running-leaf", supersedeFallback: true },
    );
    expect(state.chatMessages).toEqual(transcript);
    expect(older).toHaveBeenCalledOnce();
    const { segments, ...edges } = state.chatHistoryPagination;
    expect(edges).toEqual({ hasMore: false, totalMessages: 7 });
    expect(segments).toHaveLength(2);
    expect(segments?.every((packet) => packet.boundedPacket)).toBe(true);
  });

  it("refills a fresh tail while the prior mounted reader still names the old prefix", async () => {
    const tail = tailFrom(4);
    const older = vi.fn(async (cursor: string) =>
      cursor === "older:tail"
        ? {
            messages: transcript.slice(2, 4),
            hasMore: true,
            olderCursor: "older:head",
            totalMessages: 7,
            sessionInfo,
          }
        : { messages: transcript.slice(0, 2), totalMessages: 7, sessionInfo },
    );
    const { state } = await loadAfterLiveTurn(
      { ...tail, sessionInfo: { ...tail.sessionInfo, activeLeafEntryId: "stopped-leaf" } },
      older,
      {
        previousLeaf: "running-leaf",
        beforeRefresh: (refreshState) => {
          refreshState.readTranscriptReaderSnapshot = () => ({
            anchor: "id:prompt",
            visibleSources: ["id:prompt", "id:call-2"],
          });
        },
      },
    );
    expect(older.mock.calls).toEqual([["older:tail"], ["older:head"]]);
    expect(state.chatMessages).toEqual(transcript);
    expect(state.chatDisplayedLeafEntryId).toBe("stopped-leaf");
  });

  it("keeps the retryable boundary when the gap read fails", async () => {
    const { state } = await loadAfterLiveTurn(tailFrom(2), async () => {
      throw new Error("offline");
    });
    expect(state.chatMessages).not.toContainEqual(prompt);
    const { segments, ...edges } = state.chatHistoryPagination;
    expect(edges).toEqual({
      hasMore: true,
      olderCursor: "older:tail",
      nextOffset: 5,
      totalMessages: 7,
    });
    expect(segments).toHaveLength(1);
    expect(state.lastError).toBeNull();
  });

  it("keeps each fresh gap response's provenance instead of certifying an aggregate packet", async () => {
    const older = vi.fn(async (cursor: string): Promise<ChatHistoryResult> =>
      cursor === "older:tail"
        ? gapPacket()
        : { messages: transcript.slice(0, 2), totalMessages: 7, sessionInfo },
    );
    const { state, request } = await loadAfterLiveTurn(tailFrom(4), older);

    expect(state.chatMessages).toEqual(transcript);
    expect(older.mock.calls).toEqual([["older:tail"], ["older:head"]]);
    const segments = state.chatHistoryPagination.segments;
    // All seven rows would fit one certificate; only the three actual RPCs own one each.
    expect(segments?.map((packet) => packet.sources)).toEqual([
      ["id:prompt", "id:call-2"],
      ["id:result-3", "id:call-4"],
      ["id:result-5", "id:call-6", "id:call-7"],
    ]);
    expect(segments?.every((packet) => packet.boundedPacket)).toBe(true);
    for (const [method, params] of request.mock.calls) {
      if ((params as { cursor?: string }).cursor?.startsWith("older:")) {
        expect(method).toBe("chat.history");
        expect(params).toMatchObject({ limit: 80, maxBytes: 256 * 1024 });
      }
    }
  });

  it("keeps the fresh contiguous prefix and retry boundary when a later gap packet fails", async () => {
    const { state } = await loadAfterLiveTurn(tailFrom(4), async (cursor) => {
      if (cursor === "older:head") {
        throw new Error("offline");
      }
      return gapPacket();
    });

    expect(state.chatMessages).toEqual(transcript.slice(2));
    expect(state.chatHistoryPagination).toMatchObject({
      hasMore: true,
      olderCursor: "older:head",
      nextOffset: 5,
      totalMessages: 7,
    });
    expect(state.chatHistoryPagination.segments).toHaveLength(2);
    expect(state.lastError).toBeNull();
  });

  it.each(["selection", "claim"] as const)(
    "discards a held Stop-gap response after its %s retires",
    async (retirement) => {
      const entered = createDeferred();
      const pending = createDeferred<ChatHistoryResult>();
      let current: TestState | undefined;
      const reply = gapPacket();
      const loading = loadAfterLiveTurn(
        tailFrom(4),
        async () => {
          entered.resolve();
          return pending.promise;
        },
        { captureState: (state) => (current = state) },
      );
      await entered.promise;
      if (!current) {
        throw new Error("expected the held hydration owner");
      }
      const messages = current.chatMessages;
      const pagination = current.chatHistoryPagination;
      if (retirement === "selection") {
        current.sessionKey = "replacement";
      } else {
        beginHistoryRequest(current, current.client!, current.connectionEpoch, current.sessionKey);
      }
      pending.resolve(reply);
      const { state, request } = await loading;

      expect(state.chatMessages).toBe(messages);
      expect(state.chatHistoryPagination).toBe(pagination);
      expect(
        request.mock.calls.filter(([, params]) =>
          (params as { cursor?: string }).cursor?.startsWith("older:"),
        ),
      ).toHaveLength(1);
    },
  );

  it("keeps the fresh tail's lazy edge when a bounded gap packet cannot fit beside it", async () => {
    const tail = { ...tailFrom(4, 83), messages: [81, 82, 83].map(call) };
    const gap = Array.from({ length: 80 }, (_, index) =>
      Array.from({ length: 5 }, (_fragment, fragment) =>
        message("assistant", `gap ${index + 1} fragment ${fragment}`, {
          id: `gap-${index + 1}`,
          seq: index + 1,
        }),
      ),
    ).flat();
    expect(Buffer.byteLength(JSON.stringify(gap))).toBeLessThanOrEqual(256 * 1024);
    const older = vi.fn(async () => ({ messages: gap, totalMessages: 83, sessionInfo }));
    const { state, request } = await loadAfterLiveTurn(tail, older);

    expect(state.chatMessages).toEqual(tail.messages);
    expect(state.chatMessages.length).toBeLessThanOrEqual(400);
    expect(state.chatHistoryPagination).toMatchObject({
      hasMore: true,
      olderCursor: "older:tail",
      nextOffset: 3,
      totalMessages: 83,
    });
    expect(state.chatHistoryPagination.segments).toHaveLength(1);
    expect(state.chatHistoryPagination.segments?.[0]?.sources).toEqual([
      "id:call-81",
      "id:call-82",
      "id:call-83",
    ]);
    expect(older).toHaveBeenCalledOnce();
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ limit: 80, maxBytes: 256 * 1024 });
    expect(state.lastError).toBeNull();
  });

  it("reserves local output when a Stop-gap packet would otherwise evict the accepted tail", async () => {
    const tail = { ...tailFrom(4, 83), messages: [81, 82, 83].map(call) };
    const output = {
      role: "system",
      content: "x".repeat(CHAT_RESIDENT_WEIGHT_TARGET - 128 * 1024),
    };
    const gap = Array.from({ length: 80 }, (_, index) =>
      message("assistant", "g".repeat(2 * 1024), { id: `gap-${index + 1}`, seq: index + 1 }),
    );
    expect(Buffer.byteLength(JSON.stringify(gap))).toBeLessThanOrEqual(256 * 1024);
    expect(prepareChatHistoryPacket(gap, { hasMore: false }).boundedPacket).toBe(true);
    const older = vi.fn(async () => ({ messages: gap, totalMessages: 83, sessionInfo }));
    const { state } = await loadAfterLiveTurn(tail, older, {
      beforeRefresh: (current) =>
        reduceChatSessionProjection(current, { type: "localOutput", message: output }),
    });

    expect(state.chatMessages).toEqual([output, ...tail.messages]);
    expect(JSON.stringify(state.chatMessages).length).toBeLessThanOrEqual(
      CHAT_RESIDENT_WEIGHT_TARGET,
    );
    expect(state.chatHistoryPagination).toMatchObject({
      hasMore: true,
      olderCursor: "older:tail",
      nextOffset: 3,
      totalMessages: 83,
    });
    expect(state.chatHistoryPagination.segments?.map((packet) => packet.sources)).toEqual([
      ["id:call-81", "id:call-82", "id:call-83"],
    ]);
    expect(state.chatHistoryPagination.segments?.[0]?.boundedPacket).toBe(true);
    expect(older).toHaveBeenCalledOnce();
  });

  it("preserves a detached head and its reader when Stop resets the tail cursor", async () => {
    const state = createState(tailFrom(4));
    state.currentSessionId = "session";
    state.chatDisplayedLeafEntryId = undefined;
    const head = {
      messages: transcript.slice(0, 2),
      newerCursor: "newer:head",
      totalMessages: 7,
      deltaCursor: "before-stop",
      sessionInfo: { ...sessionInfo, hasActiveRun: true },
    };
    const request = vi.spyOn(state.client!, "request").mockResolvedValueOnce(head);
    await loadChatHistory(state);
    expect(state.chatHistoryPagination).toMatchObject({
      hasMore: false,
      hasNewer: true,
      newerCursor: "newer:head",
    });
    const held = state.chatMessages;
    const coverage = state.chatHistoryPagination;
    const reader = vi.fn(() => ({ anchor: "id:prompt", visibleSources: ["id:prompt"] }));
    state.readTranscriptReaderSnapshot = reader;
    request
      .mockResolvedValueOnce({ kind: "reset" })
      .mockResolvedValueOnce(tailFrom(4))
      .mockResolvedValueOnce({ messages: transcript.slice(0, 4), totalMessages: 7, sessionInfo });

    await loadChatHistory(state);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: "before-stop" });
    expect(state.chatMessages).toEqual(held);
    expect(state.chatMessages[0]).toBe(held[0]);
    expect(state.chatHistoryPagination).toStrictEqual(coverage);
    expect(state.readTranscriptReaderSnapshot).toBe(reader);
    expect(state.readTranscriptReaderSnapshot()?.anchor).toBe("id:prompt");
  });

  describe("detached Stop continuity", () => {
    const selected = (accepted = true): ChatHistoryResult => ({
      messages: [prompt, call(2)],
      newerCursor: "newer:selected",
      deltaCursor: "after-stop",
      sessionInfo: { ...sessionInfo, activeLeafEntryId: "stopped-leaf" },
      continuity: { cursor: "before-stop", activeLeafEntryId: "running-leaf", accepted },
    });
    async function detached() {
      const state = createState(tailFrom(4));
      state.renderLifecycle = { afterCommit: () => () => undefined };
      onTestFinished(() => cancelChatScroll(state));
      state.currentSessionId = "session";
      state.chatDisplayedLeafEntryId = undefined;
      const request = vi.spyOn(state.client!, "request").mockResolvedValueOnce({
        messages: [prompt, call(2)],
        newerCursor: "newer:head",
        deltaCursor: "before-stop",
        sessionInfo: { ...sessionInfo, activeLeafEntryId: "running-leaf" },
      });
      await loadChatHistory(state);
      expect(state.chatHistoryPagination.hasNewer).toBe(true);
      state.readTranscriptReaderSnapshot = () => ({
        anchor: "id:prompt",
        visibleSources: ["id:prompt"],
      });
      return { state, request };
    }
    const tail = () => ({
      ...tailFrom(4),
      deltaCursor: "first-tail",
      inputReceipts: [
        { runId: "first-tail-only", state: "consumed" as const, consumedByEventId: "call-7" },
      ],
      sessionInfo: { ...sessionInfo, activeLeafEntryId: "stopped-leaf" },
    });

    it("fits the stopped-leaf packet without charging retired running-leaf native pins", async () => {
      const { state, request } = await detached();
      const pin = message("assistant", "p".repeat(CHAT_RESIDENT_WEIGHT_TARGET - 128 * 1024), {
        id: "old-pin",
        seq: 100,
        runId: "old-run",
      });
      reduceChatSessionProjection(state, { type: "runDelta", runId: "old-run", message: pin });
      reduceChatSessionProjection(state, { type: "messagePersisted", message: pin });
      expect(state.chatMessages).toContain(pin);
      const selectedCall = {
        ...call(2),
        content: [{ type: "text", text: "s".repeat(200 * 1024) }],
      };
      const page = { ...selected(), messages: [prompt, selectedCall] };
      expect(new TextEncoder().encode(JSON.stringify(page.messages)).length).toBeLessThan(
        256 * 1024,
      );
      request
        .mockResolvedValueOnce({ kind: "reset" })
        .mockResolvedValueOnce(tail())
        .mockResolvedValueOnce(page);
      await loadChatHistory(state);
      expect(getChatHistoryLoadState(state).phase).toBe("committed");
      expect(state.chatMessages).toEqual([prompt, selectedCall]);
      expect(state.chatMessages).not.toContain(pin);
      expect(getChatSessionProjection(state).scope.activeLeafEntryId).toBe("stopped-leaf");
    });

    it("replaces only the selected packet and keeps a real command arriving during continuity validation", async () => {
      const { state, request } = await detached();
      const entered = createDeferred();
      const page = createDeferred<ChatHistoryResult>();
      request
        .mockResolvedValueOnce({ kind: "reset" })
        .mockResolvedValueOnce(tail())
        .mockImplementationOnce(async () => {
          entered.resolve();
          return page.promise;
        });
      const loading = loadChatHistory(state);
      await entered.promise;
      expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
        messageId: "prompt",
        sessionId: "session",
        limit: 80,
        maxBytes: 256 * 1024,
        continuity: { cursor: "before-stop", activeLeafEntryId: "running-leaf" },
      });
      await expect(dispatchChatSlashCommand(state, "help", "")).resolves.toBe("completed");
      const outputs = getChatSessionProjection(state).entries.filter((entry) => entry.localOutput);
      expect(outputs).toHaveLength(1);
      const output = outputs[0]?.message;
      expect(output).toBeDefined();
      page.resolve(selected());
      const restored = await loading;

      expect(restored).toMatchObject({
        deltaCursor: "after-stop",
        sessionInfo: { activeLeafEntryId: "stopped-leaf" },
        observation: expect.any(Object),
      });
      for (const key of ["olderCursor", "nextOffset", "inputReceipts"]) {
        expect(restored).not.toHaveProperty(key);
      }
      expect(state.lastError).toBeNull();
      expect(state.chatMessages).toEqual([prompt, call(2), output]);
      expect(state.chatMessages.at(-1)).toBe(output);
      expect(
        getChatSessionProjection(state).entries.filter((entry) => entry.localOutput),
      ).toHaveLength(1);
      expect(state.chatDisplayedLeafEntryId).toBe("stopped-leaf");
      expect(state.chatHistoryPagination).toMatchObject({
        hasMore: false,
        hasNewer: true,
        newerCursor: "newer:selected",
      });
      expect(state.chatHistoryPagination).not.toHaveProperty("olderCursor");
      expect(state.chatHistoryPagination).not.toHaveProperty("nextOffset");
      expect(state.chatHistoryPagination.segments?.flatMap((segment) => segment.sources)).toEqual([
        "id:prompt",
        "id:call-2",
      ]);
      expect(state.chatHistoryPagination.segments?.every((segment) => segment.boundedPacket)).toBe(
        true,
      );
      expect(request).toHaveBeenCalledTimes(4);
    });

    it.each(["off-path", "not-found", "capacity"] as const)(
      "leaves the failed held owner untouched when continuity is %s",
      async (outcome) => {
        const { state, request } = await detached();
        await dispatchChatSlashCommand(state, "help", "");
        const held = state.chatMessages;
        const coverage = state.chatHistoryPagination;
        const scope = getChatSessionProjection(state).scope;
        const response = selected(outcome !== "off-path");
        if (outcome === "not-found") {
          response.messages = [];
          // The first tail may have come from a transient sibling. Its rows and
          // opaque edges cannot borrow a later accepted but absent selection.
        } else if (outcome === "capacity") {
          const output = getChatSessionProjection(state).entries.find((entry) => entry.localOutput);
          expect(output).toBeDefined();
          reduceChatSessionProjection(state, {
            type: "localOutput",
            message: {
              role: "system",
              content: "x".repeat(CHAT_RESIDENT_WEIGHT_TARGET - 128 * 1024),
            },
          });
          response.messages = [
            prompt,
            message("assistant", "g".repeat(160 * 1024), { id: "selected-neighbor", seq: 2 }),
          ];
          expect(Buffer.byteLength(JSON.stringify(response.messages))).toBeLessThanOrEqual(
            256 * 1024,
          );
          expect(
            prepareChatHistoryPacket(response.messages, { hasMore: false }).boundedPacket,
          ).toBe(true);
        }
        const before = state.chatMessages;
        const beforeCoverage = state.chatHistoryPagination;
        request
          .mockResolvedValueOnce({ kind: "reset" })
          .mockResolvedValueOnce({
            ...tail(),
            sessionInfo: { ...sessionInfo, activeLeafEntryId: "transient-sibling" },
          })
          .mockResolvedValueOnce(response);
        await loadChatHistory(state);
        expect(getChatHistoryLoadState(state)).toMatchObject({
          phase: "failed",
          message: t(
            outcome === "capacity"
              ? "chat.thread.historyCapacity"
              : "chat.messages.originalUnavailable",
          ),
        });
        expect(state.chatMessages).toBe(before);
        expect(state.chatHistoryPagination).toStrictEqual(beforeCoverage);
        expect(getChatSessionProjection(state).scope).toEqual(scope);
        expect(state.chatDisplayedLeafEntryId).toBe("running-leaf");
        expect(state.readTranscriptReaderSnapshot?.()?.anchor).toBe("id:prompt");
        expect(request).toHaveBeenCalledTimes(4);
        if (outcome !== "capacity") {
          expect(state.chatMessages).toBe(held);
          expect(state.chatHistoryPagination).toStrictEqual(coverage);
        }
      },
    );

    it("does not probe readable old physical history after the logical session was replaced", async () => {
      const { state, request } = await detached();
      await dispatchChatSlashCommand(state, "help", "");
      const oldOutput = getChatSessionProjection(state).entries.find(
        (entry) => entry.localOutput,
      )?.message;
      const fresh = message("user", "new physical session", { id: "new-physical", seq: 1 });
      request
        .mockResolvedValueOnce({ kind: "reset" })
        .mockResolvedValueOnce({
          messages: [fresh],
          deltaCursor: "new-physical-cursor",
          sessionInfo: {
            ...sessionInfo,
            sessionId: "physical-new",
            activeLeafEntryId: "new-physical",
          },
        })
        .mockResolvedValueOnce(selected());
      await loadChatHistory(state);
      expect(request).toHaveBeenCalledTimes(3);
      expect(state.currentSessionId).toBe("physical-new");
      expect(state.chatMessages).toEqual([fresh]);
      expect(state.chatMessages).not.toContain(oldOutput);
      expect(getChatSessionProjection(state).entries.some((entry) => entry.localOutput)).toBe(
        false,
      );
    });

    it.each(["reader", "manual", "scope", "connection"] as const)(
      "does not admit a held response after %s ownership changes",
      async (change) => {
        const { state, request } = await detached();
        const entered = createDeferred();
        const page = createDeferred<ChatHistoryResult>();
        request
          .mockResolvedValueOnce({ kind: "reset" })
          .mockResolvedValueOnce(tail())
          .mockImplementationOnce(async () => {
            entered.resolve();
            return page.promise;
          });
        const loading = loadChatHistory(state);
        await entered.promise;
        const held = state.chatMessages;
        if (change === "reader") {
          state.readTranscriptReaderSnapshot = () => ({
            anchor: "id:call-2",
            visibleSources: ["id:call-2"],
          });
        } else if (change === "manual") {
          beginChatScrollIntent(state);
          onTestFinished(() => cancelChatScroll(state));
        } else if (change === "scope") {
          publishChatSessionProjection(state, {
            ...getChatSessionProjection(state),
            scope: { ...getChatSessionProjection(state).scope, lifecycleRevision: "next-life" },
          });
        } else {
          state.connectionEpoch++;
        }
        const current = state.chatMessages;
        page.resolve(selected());
        await loading;
        expect(state.chatMessages).toBe(current);
        expect(state.chatMessages).toEqual(held);
        expect(state.chatDisplayedLeafEntryId).toBe("running-leaf");
        cancelChatScroll(state);
      },
    );
  });

  it.each([
    ["the full read did not follow a cursor reset", tailFrom(2), { cursorReset: false }],
    ["the gap exceeds one older page", tailFrom(2, 2000), {}],
  ])("keeps the lazy boundary when %s", async (_case, tail, options) => {
    const older = vi.fn(async () => ({ messages: transcript.slice(0, 2), sessionInfo }));
    const { state } = await loadAfterLiveTurn(tail, older, options);
    expect(older).not.toHaveBeenCalled();
    expect(state.chatHistoryPagination).toMatchObject({ hasMore: true, olderCursor: "older:tail" });
  });
});
