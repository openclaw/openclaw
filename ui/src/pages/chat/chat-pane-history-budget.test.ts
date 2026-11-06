/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { readChatHistoryRequestBudget } from "./chat-history-request-budget.ts";
import "./chat-pane.tsx";
import {
  admitChatHistoryPages,
  prepareChatHistoryPages,
  resolveChatHistoryPagination,
  type ChatHistoryResult,
} from "./chat-history-snapshot.ts";
import { prepareChatHistoryPacket } from "./chat-history-window.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createStagedPrefetchPane,
  appendChatThread,
  nativeHistoryMessage,
  nativeHistorySeq,
  expectNativeHistoryRange,
} from "./chat-pane-history.test-support.ts";
import { readChatInputRunIds } from "./chat-pending-inputs.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import { createTranscriptMessageElements } from "./components/chat-transcript-message-elements.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";

function mountReaderMessages(
  pane: ReturnType<typeof createStagedPrefetchPane>["pane"],
  messages: unknown[],
  detached = false,
) {
  const thread = appendChatThread(pane);
  vi.spyOn(thread, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 500 } as DOMRect);
  const refs = createTranscriptMessageElements(() => undefined);
  for (const [index, item] of buildMessageItems(messages).entries()) {
    const bubble = document.createElement("div");
    if (!detached) {
      thread.append(bubble);
    }
    vi.spyOn(bubble, "getBoundingClientRect").mockReturnValue({
      top: 20 + index * 100,
      bottom: 80 + index * 100,
    } as DOMRect);
    refs.forKey(item.key)(bubble);
  }
  vi.spyOn(pane.transcript, "messageElements", "get").mockReturnValue(refs);
}

function source(seq: number, keyed = true) {
  return Object.assign(nativeHistoryMessage(seq, "x".repeat(4_000)), {
    __openclaw: { seq, ...(keyed ? { id: `source-${seq}` } : {}) },
  });
}

type Request = { cursor: string; limit: number; maxBytes: number };

function page(start: number, end: number, keyed = true): ChatHistoryResult {
  return {
    messages: Array.from({ length: end - start + 1 }, (_, index) => source(start + index, keyed)),
    hasMore: start > 1,
    ...(start > 1 ? { olderCursor: `older-${start - 1}` } : {}),
    ...(end < 400 ? { newerCursor: `newer-${end + 1}` } : {}),
  };
}

function capacityReaderPane(request: Parameters<typeof createStagedPrefetchPane>[0]) {
  const fixture = createStagedPrefetchPane(request);
  readChatInputRunIds(fixture.state);
  admitChatHistoryPages(fixture.state, [page(400, 400)], "around");
  fixture.state.readTranscriptReaderSnapshot = () => ({
    anchor: "id:source-400",
    visibleSources: ["id:source-400"],
  });
  return fixture;
}

it.each(["older", "newer"] as const)(
  "reserves the complete mounted viewport after hydration before a %s admission",
  async (direction) => {
    const visible = direction === "older" ? [443, 444] : [399, 400];
    const wirePage = (start: number, end: number): ChatHistoryResult => ({
      ...page(start, end),
      ...(end < 900 ? { newerCursor: `newer-${end + 1}` } : {}),
      sessionInfo: {
        key: "agent:main:viewport",
        kind: "direct",
        sessionId: "physical",
        activeLeafEntryId: "leaf",
      },
    });
    const request = vi.fn(async (_method: string, params: Request) => {
      if (!params.cursor) {
        return {
          ...wirePage(842, 900),
          sessionInfo: {
            key: "agent:main:viewport",
            sessionId: "physical",
            activeLeafEntryId: "leaf",
          },
        };
      }
      const edge = Number(params.cursor.split("-")[1]);
      const older = params.cursor.startsWith("older-");
      let start = older ? Math.max(1, edge - params.limit + 1) : edge;
      let end = older ? edge : Math.min(900, edge + params.limit - 1);
      while (
        new TextEncoder().encode(JSON.stringify(wirePage(start, end).messages)).length >
        params.maxBytes
      ) {
        if (older) {
          start++;
        } else {
          end--;
        }
      }
      return wirePage(start, end);
    });
    const { pane, state } = createStagedPrefetchPane(request);
    state.sessionKey = "agent:main:viewport";
    await loadChatHistory(state, { deferBranches: true });
    expect(request.mock.calls[0]![1]).toMatchObject({ limit: 80, maxBytes: 256 * 1024 });
    expectNativeHistoryRange(state.chatMessages, 842, 59);
    const thread = appendChatThread(pane);
    vi.spyOn(thread, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 500 } as DOMRect);
    const refs = createTranscriptMessageElements(() => undefined);
    vi.spyOn(pane.transcript, "messageElements", "get").mockReturnValue(refs);
    const present = (seqs: readonly number[]) => {
      thread.replaceChildren();
      for (const [index, seq] of seqs.entries()) {
        const item = buildMessageItems(state.chatMessages).find(
          (candidate) => nativeHistorySeq(candidate.message) === seq,
        )!;
        const bubble = document.createElement("div");
        thread.append(bubble);
        vi.spyOn(bubble, "getBoundingClientRect").mockReturnValue({
          top: 20 + index * 100,
          bottom: 80 + index * 300,
        } as DOMRect);
        refs.forKey(item.key)(bubble);
      }
    };
    if (direction === "older") {
      // The ordinary small tail first grows through a real capacity-sized admission.
      present([842]);
      await expect(pane.loadOlderMessages()).resolves.toBe(true);
      expectNativeHistoryRange(state.chatMessages, 443, 400);
      expect(request.mock.calls.at(-1)![1].limit).toBe(399);
      expect(pane.stagedHistory.page).toBeNull();
      expect(pane.stagedHistory.load).toBeNull();
    } else {
      // A bounded around navigation followed by ordinary pages reaches the other edge.
      admitChatHistoryPages(state, [wirePage(1, 80)], "around");
      for (let start = 81; start <= 321; start += 80) {
        admitChatHistoryPages(state, [wirePage(start, start + 79)], "newer");
      }
    }
    present(visible);
    expect(state.readTranscriptReaderSnapshot?.()?.anchor).toBe(`id:source-${visible[0]}`);
    request.mockClear();

    await expect(
      direction === "older" ? pane.loadOlderMessages() : pane.loadNewerMessages(),
    ).resolves.toBe(true);

    const retained = state.chatMessages.map(nativeHistorySeq);
    expect(retained).toEqual(expect.arrayContaining(visible));
    expect(request.mock.calls.find(([, params]) => params.limit > 80)![1].limit).toBe(398);
    expect(retained).toHaveLength(400);
    expect(retained).toEqual(
      Array.from({ length: 400 }, (_, index) => (direction === "older" ? 45 : 399) + index),
    );
  },
);

async function hydrateCapacityPane(sessionKey: string) {
  const request = vi.fn(async (_method: string, params: Request) => {
    if (!params.cursor) {
      return {
        ...page(400, 400),
        sessionInfo: { key: sessionKey, sessionId: "physical", activeLeafEntryId: "leaf-400" },
      };
    }
    const end = Number(params.cursor.split("-")[1]);
    return page(Math.max(1, end - params.limit + 1), end);
  });
  const { pane, state } = createStagedPrefetchPane(request);
  state.sessionKey = sessionKey;
  state.assistantAgentId = sessionKey === "global" ? "main" : "unrelated-global";
  await expect(loadChatHistory(state, { deferBranches: true })).resolves.toBeDefined();
  expect(getChatSessionProjection(state).scope).toMatchObject({
    sessionKey,
    agentId: "main",
    sessionId: "physical",
    activeLeafEntryId: "leaf-400",
  });
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([400]);
  state.readTranscriptReaderSnapshot = () => ({
    anchor: "id:source-400",
    visibleSources: ["id:source-400"],
  });
  expect(request.mock.calls[0]![1]).toMatchObject({ limit: 80, maxBytes: 256 * 1024 });
  request.mockClear();
  return { pane, state, request };
}

it("keeps a fitting viewport intact after live pairing media enriches an overlapping page", async () => {
  const row = (seq: number, length: number) => ({
    ...source(seq),
    ...(seq === 39 ? { role: "assistant" } : {}),
    content: [{ type: "text", text: "x".repeat(length) }],
  });
  const qr = { type: "openclaw_pairing_qr", image_url: "data:image/png;base64,aQ==" };
  const plain = row(39, 80_000);
  const live = { ...plain, content: [...plain.content, qr] };
  const tail = row(40, 1_000);
  const incoming = Array.from({ length: 39 }, (_, index) =>
    row(index + 1, index === 37 ? 1_000 : 80_000),
  );
  const slack = 3 * 1024 * 1024 - 1 - JSON.stringify([...incoming, live, tail]).length;
  expect(slack).toBeGreaterThan(0);
  incoming[0] = row(1, 80_000 + slack);
  expect(Math.max(...incoming.map((message) => JSON.stringify(message).length))).toBeLessThan(
    128 * 1024,
  );
  const scope = {
    key: "agent:main:pairing-viewport",
    kind: "direct",
    sessionId: "physical",
    activeLeafEntryId: "leaf",
  } satisfies NonNullable<ChatHistoryResult["sessionInfo"]>;
  const result: ChatHistoryResult = {
    messages: incoming,
    hasMore: false,
    newerCursor: "newer-40",
    sessionInfo: scope,
  };
  const request = vi.fn(async (_method: string, params: Request) => {
    if (!params.cursor) {
      return { messages: [tail], hasMore: true, olderCursor: "older-39", sessionInfo: scope };
    }
    const edge = Number(params.cursor.split("-")[1]);
    const messages = incoming
      .filter((message) => message["__openclaw"].seq <= edge)
      .slice(-params.limit);
    while (new TextEncoder().encode(JSON.stringify(messages)).length > params.maxBytes) {
      messages.shift();
    }
    const first = messages[0]?.["__openclaw"].seq;
    if (first === undefined) {
      throw new Error("Expected a fitting history source");
    }
    return {
      ...result,
      messages,
      hasMore: first > 1,
      ...(first > 1 ? { olderCursor: "older-" + (first - 1) } : {}),
    };
  });
  const { pane, state } = createStagedPrefetchPane(request);
  state.sessionKey = scope.key;
  await loadChatHistory(state, { deferBranches: true });
  reduceChatSessionProjection(state, { type: "runDelta", runId: "pairing", message: live });
  reduceChatSessionProjection(state, {
    type: "messagePersisted",
    message: live,
    envelope: { runId: "pairing" },
  });
  expect(
    getChatSessionProjection(state).entries.find((entry) => entry.message === live)?.live,
  ).toBe(true);
  expect(state.chatHistoryPagination.segments?.flatMap((segment) => segment.sources)).toEqual([
    "id:source-40",
  ]);
  mountReaderMessages(pane, state.chatMessages);
  expect(state.readTranscriptReaderSnapshot?.()?.anchor).toBe("id:source-39");
  const prepared = prepareChatHistoryPages(state, [result], "older");
  expect(prepared.fits).toBe(false);
  expect(JSON.stringify(prepared.messages).length).toBeGreaterThan(3 * 1024 * 1024);

  await expect(pane.loadOlderMessages()).resolves.toBe(true);

  expect(state.chatMessages.map(nativeHistorySeq)).toContain(40);
  expect(JSON.stringify(state.chatMessages).length).toBeLessThanOrEqual(3 * 1024 * 1024);
});

it.each(["inferred", "giant-streaming", "giant-provisional"] as const)(
  "charges a real uncovered %s pin without giving it pagination coverage",
  async (mode) => {
    const prompt = {
      ...source(40),
      role: "user",
      __openclaw: { id: "source-40", seq: 40, runId: "pin" },
    };
    const candidate = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: mode === "inferred" ? "selected answer" : "x".repeat(3 * 1024 * 1024),
        },
      ],
      ...(mode === "giant-provisional"
        ? {}
        : { __openclaw: { id: "source-41", seq: 41, runId: "pin" } }),
    };
    const scope = {
      key: "agent:main:uncovered-pin",
      sessionId: "physical",
      activeLeafEntryId: "leaf",
    };
    const request = vi.fn(async (_method: string, params: Request) =>
      params.cursor
        ? { ...page(1, 39), hasMore: false, newerCursor: "newer-40", sessionInfo: scope }
        : {
            messages: [prompt],
            hasMore: true,
            olderCursor: "older-39",
            newerCursor: "newer-41",
            sessionInfo: scope,
          },
    );
    const { pane, state } = createStagedPrefetchPane(request);
    state.sessionKey = scope.key;
    await loadChatHistory(state, { deferBranches: true });
    if (mode === "inferred") {
      const original = { role: "assistant", content: candidate.content };
      reduceChatSessionProjection(state, {
        type: "runTerminal",
        runId: "pin",
        status: "completed",
        message: original,
      });
      reduceChatSessionProjection(state, {
        type: "messagePersisted",
        message: original,
        envelope: { runId: "pin" },
      });
      reduceChatSessionProjection(state, { type: "snapshotLoaded", messages: [prompt, candidate] });
      expect(
        getChatSessionProjection(state).runs.pin?.inferredSnapshotTerminal?.matchedIdentity.id,
      ).toBe("source-41");
    } else {
      reduceChatSessionProjection(state, { type: "runDelta", runId: "pin", message: candidate });
      reduceChatSessionProjection(state, {
        type: "messagePersisted",
        message: candidate,
        envelope: { runId: "pin" },
      });
    }
    expect(state.chatMessages).toContain(candidate);
    expect(state.chatHistoryPagination.segments?.flatMap((segment) => segment.sources)).toEqual([
      "id:source-40",
    ]);
    mountReaderMessages(pane, state.chatMessages);
    expect(state.readTranscriptReaderSnapshot?.()).toEqual({
      anchor: "id:source-40",
      visibleSources:
        mode === "giant-provisional" ? ["id:source-40"] : ["id:source-40", "id:source-41"],
    });
    const budget = readChatHistoryRequestBudget(state, prepareChatHistoryPages(state, [], "older"));
    expect(budget?.limit).toBe(mode === "inferred" ? 398 : undefined);
    request.mockClear();

    await expect(pane.loadOlderMessages()).resolves.toBe(true);

    expect(request.mock.calls[0]![1].limit).toBe(mode === "inferred" ? 398 : 80);
    expect(state.chatMessages.filter((message) => message === candidate)).toHaveLength(1);
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([
      ...Array.from({ length: 40 }, (_, index) => index + 1),
      mode === "giant-provisional" ? undefined : 41,
    ]);
    expect(
      state.chatHistoryPagination.segments?.flatMap((segment) => segment.sources),
    ).not.toContain("id:source-41");
    expect(state.chatHistoryPagination.hasNewer).toBe(true);
  },
);

it.each(["visible", "local-first", "detached", "hidden", "unavailable"] as const)(
  "reads one body-free mounted reader snapshot (%s)",
  (mode) => {
    const { pane, state } = createStagedPrefetchPane(vi.fn());
    const native = [source(1), source(1), source(2)];
    state.chatMessages =
      mode === "local-first"
        ? [{ role: "system", content: "local command result" }, ...native]
        : native;
    mountReaderMessages(pane, state.chatMessages, mode === "detached");
    if (mode === "hidden") {
      pane.visuallyPresented = false;
    }
    if (mode === "unavailable") {
      vi.spyOn(pane.transcript, "scrollElement", "get").mockReturnValue(null);
    }
    expect(state.readTranscriptReaderSnapshot?.()).toEqual(
      mode === "visible" || mode === "local-first"
        ? {
            anchor: mode === "local-first" ? null : "id:source-1",
            visibleSources: ["id:source-1", "id:source-2"],
          }
        : null,
    );
  },
);

it("allows explicit around replacement of the old mounted viewport", async () => {
  const scope = {
    key: "agent:main:around",
    kind: "direct",
    sessionId: "physical",
    activeLeafEntryId: "leaf",
  } satisfies NonNullable<ChatHistoryResult["sessionInfo"]>;
  const { pane, state } = createStagedPrefetchPane(
    vi.fn(async () => ({
      messages: [source(443), source(444)],
      hasMore: true,
      olderCursor: "older-442",
      newerCursor: "newer-445",
      sessionInfo: scope,
    })),
  );
  state.sessionKey = scope.key;
  await loadChatHistory(state, { deferBranches: true });
  mountReaderMessages(pane, state.chatMessages);
  expect(state.readTranscriptReaderSnapshot?.()?.visibleSources).toEqual([
    "id:source-443",
    "id:source-444",
  ]);
  const tail = {
    messages: Array.from({ length: 59 }, (_, index) => source(842 + index)),
    hasMore: true,
    olderCursor: "older-841",
    sessionInfo: scope,
  };
  expect(prepareChatHistoryPages(state, [tail], "around").fits).toBe(true);
  expect(admitChatHistoryPages(state, [tail], "around")).toBe("messages");
  expectNativeHistoryRange(state.chatMessages, 842, 59);
});

it("reserves every visible native fragment before a newer admission", async () => {
  const held = [399, 400].flatMap((seq) => [
    source(seq),
    { ...source(seq), content: [{ type: "text", text: "other fragment" }] },
  ]);
  const scope = { key: "agent:main:fragments", sessionId: "physical", activeLeafEntryId: "leaf" };
  const request = vi.fn(async (_method: string, params: Request) =>
    params.cursor
      ? {
          messages: Array.from({ length: params.limit }, (_, index) => source(401 + index)),
          hasMore: true,
          olderCursor: "older-400",
          sessionInfo: scope,
        }
      : {
          messages: held,
          hasMore: true,
          olderCursor: "older-398",
          newerCursor: "newer-401",
          sessionInfo: scope,
        },
  );
  const { pane, state } = createStagedPrefetchPane(request);
  state.sessionKey = scope.key;
  await loadChatHistory(state, { deferBranches: true });
  mountReaderMessages(pane, state.chatMessages);
  expect(state.chatMessages).toEqual(held);
  request.mockClear();
  await expect(pane.loadNewerMessages()).resolves.toBe(true);
  expect(request.mock.calls[0]![1].limit).toBe(396);
  expect(state.chatMessages).toHaveLength(400);
  expect(state.chatMessages.slice(0, 4)).toEqual(held);
  held.forEach((message, index) => expect(state.chatMessages[index]).toBe(message));
});

it.each(["global", "agent:main:capacity"])(
  "amortizes foreground reads after actual selected-session hydration (%s)",
  async (sessionKey) => {
    const { pane, request } = await hydrateCapacityPane(sessionKey);
    await expect(pane.loadOlderMessages()).resolves.toBe(true);
    expect(request.mock.calls[0]![1].limit).toBe(399);
    expect(request.mock.calls[0]![1].maxBytes).toBeGreaterThan(256 * 1024);
  },
);

it.each(["session", "leaf", "agent"] as const)(
  "refuses hydrated capacity after the current %s changes",
  async (changed) => {
    const { state } = await hydrateCapacityPane("global");
    if (changed === "session") {
      state.currentSessionId = "replacement";
    } else if (changed === "leaf") {
      state.chatDisplayedLeafEntryId = "replacement";
    } else {
      state.assistantAgentId = "replacement";
    }
    expect(
      readChatHistoryRequestBudget(state, prepareChatHistoryPages(state, [], "older")),
    ).toBeUndefined();
  },
);

it("refuses capacity when a learned lifecycle is unavailable to the current scope", async () => {
  const { state } = await hydrateCapacityPane("global");
  getChatSessionProjection(state, {
    ...getChatSessionProjection(state).scope,
    lifecycleRevision: "learned",
  });
  expect(
    readChatHistoryRequestBudget(state, prepareChatHistoryPages(state, [], "older")),
  ).toBeUndefined();
});

it.each([true, false])(
  "amortizes keyed foreground reads against the complete reader bridge (keyed bridge=%s)",
  async (keyedBridge) => {
    const request = vi.fn(async (_method: string, params: Request) => {
      const end = Number(params.cursor.split("-")[1]);
      return page(Math.max(1, end - params.limit + 1), end);
    });
    const { pane, state } = createStagedPrefetchPane(request);
    readChatInputRunIds(state);
    const initial = page(400, 400, keyedBridge);
    initial.packet = prepareChatHistoryPacket(
      initial.messages!,
      resolveChatHistoryPagination(initial),
    );
    admitChatHistoryPages(state, [initial], "around");
    state.readTranscriptReaderSnapshot = () => ({
      anchor: `${keyedBridge ? "id:source-" : "seq:"}400`,
      visibleSources: [`${keyedBridge ? "id:source-" : "seq:"}400`],
    });

    await expect(pane.loadOlderMessages()).resolves.toBe(true);

    expect(request.mock.calls[0]![1].limit).toBe(399);
    expect(request.mock.calls[0]![1].maxBytes).toBeGreaterThan(256 * 1024);
    expect(request).toHaveBeenCalledTimes(1);
    expectNativeHistoryRange(state.chatMessages, 1, 400);
    expect(state.chatHistoryPagination.segments?.at(-1)?.boundedPacket).toBe(true);
    expect(state.chatHistoryPagination.segments?.[0]?.boundedPacket).not.toBe(true);
    expect(pane.stagedHistory.page).toBeNull();
  },
);

it.each(["unkeyed", "mixed", "hidden-unkeyed"] as const)(
  "retries an actual %s larger response at the same cursor and keeps that claim small-only",
  async (kind) => {
    const request = vi.fn(async (_method: string, params: Request) => {
      const end = Number(params.cursor.split("-")[1]);
      const result = page(Math.max(1, end - params.limit + 1), end, kind !== "unkeyed");
      if (kind !== "unkeyed") {
        result.messages![0] = {
          role: "user",
          content: kind === "hidden-unkeyed" ? "" : "unkeyed",
          __openclaw: { seq: nativeHistorySeq(result.messages![0]) },
        };
      }
      // The raw source still has its sequence when the server omits its reopenable ID.
      while (
        new TextEncoder().encode(JSON.stringify(result.messages)).byteLength > params.maxBytes
      ) {
        result.messages!.shift();
      }
      const first = nativeHistorySeq(result.messages![0])!;
      return {
        ...result,
        hasMore: first > 1,
        ...(first > 1 ? { olderCursor: `older-${first - 1}` } : {}),
      };
    });
    const { pane, state } = capacityReaderPane(request);

    await expect(pane.loadOlderMessages()).resolves.toBe(true);

    expect(
      request.mock.calls.slice(0, 2).map(([, params]) => [params.cursor, params.limit]),
    ).toEqual([
      ["older-399", 399],
      ["older-399", 80],
    ]);
    expect(request.mock.calls.slice(1).every(([, params]) => params.maxBytes === 256 * 1024)).toBe(
      true,
    );
    expect(state.chatMessages).toHaveLength(kind === "hidden-unkeyed" ? 399 : 400);
    expect(state.chatHistoryPagination.hasMore).toBe(false);
  },
);

it("does not certify a large raw packet after hidden rows reduce its visible body", async () => {
  const hidden = Array.from({ length: 100 }, (_, index) => ({
    role: "user",
    content: "",
    __openclaw: { id: `hidden-${index}`, seq: index + 1 },
  }));
  const request = vi.fn(async (_method: string, _params: Request) => ({
    messages: [...hidden, source(399)],
    hasMore: false,
  }));
  const { pane, state } = capacityReaderPane(request);
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  expect(state.chatMessages.map(nativeHistorySeq)).toEqual([399, 400]);
  expect(state.chatHistoryPagination.segments?.[0]?.boundedPacket).not.toBe(true);
});

it("discards rejected raw receipts and edges before the same-cursor small reply settles", async () => {
  const small = createDeferred<ChatHistoryResult>();
  const request = vi.fn(async (_method: string, params: Request) =>
    params.limit > 80
      ? {
          messages: [
            {
              role: "user",
              content: "pending",
              __openclaw: { id: "receipt", seq: 1, idempotencyKey: "pending:user" },
            },
            ...page(2, 100, false).messages!,
          ],
          hasMore: true,
          olderCursor: "rejected-edge",
          inputReceipts: [
            { runId: "pending", state: "consumed" as const, consumedByEventId: "receipt" },
          ],
        }
      : small.promise,
  );
  const { pane, state } = capacityReaderPane(request);
  reduceChatSessionProjection(state, {
    type: "sendPending",
    runId: "pending",
    message: { role: "user", content: "pending", __openclaw: { idempotencyKey: "pending:user" } },
  });
  const before = state.chatMessages;
  const coverage = state.chatHistoryPagination;
  const loading = pane.loadOlderMessages();
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([, params]) => params.cursor)).toEqual([
      "older-399",
      "older-399",
    ]);
    expect(state.chatMessages).toBe(before);
    expect(state.chatHistoryPagination).toBe(coverage);
    expect(getChatSessionProjection(state).entries.some((entry) => entry.pending)).toBe(true);
    expect(pane.stagedHistory.page).toBeNull();
  } finally {
    small.resolve({ messages: [source(399)], hasMore: false });
    await loading;
  }
});

it("uses the same capacity owner for foreground newer reads", async () => {
  const request = vi.fn(async (_method: string, params: Request) => {
    const start = Number(params.cursor.split("-")[1]);
    return page(start, Math.min(400, start + params.limit - 1));
  });
  const { pane, state } = createStagedPrefetchPane(request);
  readChatInputRunIds(state);
  const initial = page(1, 1);
  initial.packet = prepareChatHistoryPacket(
    initial.messages!,
    resolveChatHistoryPagination(initial),
    initial.newerCursor,
  );
  admitChatHistoryPages(state, [initial], "around");
  state.readTranscriptReaderSnapshot = () => ({
    anchor: "id:source-1",
    visibleSources: ["id:source-1"],
  });
  await expect(pane.loadNewerMessages()).resolves.toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![1]).toMatchObject({ cursor: "newer-2", limit: 399 });
  expectNativeHistoryRange(state.chatMessages, 1, 400);
});

it("reports discarded large-prefix capacity after a local reply arrives during the next read", async () => {
  const next = createDeferred<ChatHistoryResult>();
  const request = vi.fn(async (_method: string, params: Request) =>
    params.cursor === "older-399" ? page(300, 399) : next.promise,
  );
  const { pane, state } = capacityReaderPane(request);
  const loading = pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  reduceChatSessionProjection(state, {
    type: "localOutput",
    message: { role: "system", content: "x".repeat(3 * 1024 * 1024 - 100_000) },
  });
  const before = state.chatMessages;
  const coverage = state.chatHistoryPagination;
  next.resolve({ messages: [source(299)], hasMore: false });
  await expect(loading).resolves.toBe(false);
  expect(state.chatMessages).toBe(before);
  expect(state.chatHistoryPagination).toBe(coverage);
  expect(pane.stagedHistory.page).toBeNull();
  expect(pane.history.olderError).toContain("loaded messages");
});

it("keeps a fitting small prefix and prefetches from its edge after discarding later broad overflow", async () => {
  const next = createDeferred<ChatHistoryResult>();
  const request = vi.fn(async (_method: string, params: Request) => {
    if (params.cursor === "older-399") {
      return page(390, 399);
    }
    if (params.cursor === "older-389") {
      return params.maxBytes > 256 * 1024 ? page(300, 389) : page(389, 389);
    }
    return next.promise;
  });
  const { pane, state } = capacityReaderPane(request);
  const loading = pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  const local = { role: "system", content: "x".repeat(3 * 1024 * 1024 - 100_000) };
  reduceChatSessionProjection(state, { type: "localOutput", message: local });
  next.resolve({ messages: [source(299)], hasMore: false });
  await expect(loading).resolves.toBe(true);
  await vi.waitFor(() => expect(pane.stagedHistory.load).toBeNull());
  expect(state.chatMessages.filter((value) => value !== local).map(nativeHistorySeq)).toEqual(
    Array.from({ length: 11 }, (_, index) => 390 + index),
  );
  expect(state.chatMessages.filter((value) => value === local)).toHaveLength(1);
  expect(state.chatHistoryPagination).toMatchObject({ hasMore: true, olderCursor: "older-389" });
  expect(request.mock.calls.at(-1)![1]).toMatchObject({
    cursor: "older-389",
    limit: 80,
    maxBytes: 256 * 1024,
  });
  expect(pane.stagedHistory.page?.requestedCursor).toBe("older-389");
  expect(pane.stagedHistory.page?.result.packet?.boundedPacket).toBe(true);
  expect(pane.history.olderError).toBeNull();
});

it.each([true, false])(
  "retires a pending capacity-sized reply when its connection claim changes (keyed=%s)",
  async (keyed) => {
    const held = createDeferred<ChatHistoryResult>();
    const request = vi.fn(async (_method: string, _params: Request) => held.promise);
    const { pane, state } = capacityReaderPane(request);
    const before = state.chatMessages;
    const coverage = state.chatHistoryPagination;
    const loading = pane.loadOlderMessages();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    state.connectionEpoch++;
    held.resolve(page(1, 399, keyed));
    await expect(loading).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatMessages).toBe(before);
    expect(state.chatHistoryPagination).toBe(coverage);
    expect(pane.stagedHistory.page).toBeNull();
  },
);
