/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../../../packages/gateway-protocol/src/schema/logs-chat.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import * as historyRetry from "./chat-history-retry.ts";
import type { ChatHistoryResponse } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { refreshPageChat } from "./chat-state-refresh.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { hasAbortableSessionRun, isChatBusy } from "./run-lifecycle.ts";
import type { AgentEventPayload } from "./tool-stream-contract.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetTranscriptTestDom();
});

const idle = {
  key: "agent:main:cursor-custody",
  agentId: "main",
  sessionId: "cursor-custody-session",
  kind: "direct",
  updatedAt: 100,
  snapshotAt: 100,
  hasActiveRun: false,
  activeRunIds: [],
} satisfies GatewaySessionRow;

function page(row: GatewaySessionRow = idle): ChatHistoryResponse {
  return {
    messages: [],
    sessionId: row.sessionId,
    sessionInfo: row,
    deltaCursor: "cursor-custody-before",
  };
}

function delta(row: GatewaySessionRow): ChatHistoryResponse {
  return { kind: "delta", messages: [], sessionInfo: row, deltaCursor: "cursor-custody-after" };
}

async function fixture() {
  const slots: Array<{
    issued: ReturnType<typeof createDeferred<Parameters<GatewayRequestHandler>>>;
    response: ReturnType<typeof createDeferred<ChatHistoryResponse>>;
  }> = [];
  const allSlots: typeof slots = [];
  const pending: Promise<void>[] = [];
  const request = vi.fn<GatewayRequestHandler>((...args) => {
    const slot = slots.shift();
    if (!slot) {
      return asOptionalRecord(args[1])?.cursor ? delta(idle) : page();
    }
    slot.issued.resolve(args);
    return slot.response.promise;
  });
  const mounted = createMountedPanes([idle], "main", undefined, {
    "chat.history": request,
    "chat.startup": request,
    "sessions.list": (_method, params) =>
      sessionsResult(asOptionalRecord(params)?.spawnedBy ? [] : [idle], 100),
  });
  await mounted.sessions.refresh({ agentId: "main", force: true });
  const pane = mounted.mount(idle.key);
  await refreshPane(pane);
  const state = pane.state;
  expect(state.currentSessionId).toBe(idle.sessionId);
  expect(state.chatRunId).toBeNull();
  return {
    ...mounted,
    state,
    request,
    arm() {
      const slot = {
        issued: createDeferred<Parameters<GatewayRequestHandler>>(),
        response: createDeferred<ChatHistoryResponse>(),
      };
      slots.push(slot);
      allSlots.push(slot);
      return slot;
    },
    refresh(target = state) {
      const operation = refreshPageChat(target, {
        awaitHistory: true,
        deferBranches: true,
        scheduleScroll: false,
      });
      pending.push(operation);
      return operation;
    },
    start(runId: string, target: ChatPageHost = state) {
      const stream = `${runId} is working.`;
      const toolCallId = `${runId}-read`;
      mounted.emitGatewayEvent("chat", {
        sessionKey: idle.key,
        agentId: "main",
        runId,
        seq: 1,
        state: "delta",
        deltaText: stream,
      } satisfies ChatEvent);
      mounted.emitGatewayEvent("agent", {
        sessionKey: idle.key,
        agentId: "main",
        runId,
        seq: 2,
        stream: "tool",
        ts: 150,
        data: { phase: "start", name: "read", toolCallId, args: { path: "README.md" } },
      } satisfies AgentEventPayload);
      const toolIdentity = buildToolStreamIdentity(runId, toolCallId);
      expect(target.chatRunId).toBe(runId);
      expect(target.toolStreamById.has(toolIdentity)).toBe(true);
      return { runId, stream, toolIdentity, tool: target.toolStreamById.get(toolIdentity) };
    },
    async finish() {
      for (const slot of allSlots) {
        slot.response.resolve(delta(idle));
      }
      await Promise.allSettled(pending);
      await vi.dynamicImportSettled();
    },
  };
}

it.each(["previous-terminal", "identity-less"] as const)(
  "preserves a newer live run when an older %s cursor snapshot arrives",
  async (rowKind) => {
    const h = await fixture();
    try {
      const read = h.arm();
      const refresh = h.refresh();
      const [method, params] = await read.issued.promise;
      expect(method).toBe("chat.history");
      expect(params).toHaveProperty("cursor", "cursor-custody-before");
      const live = h.start("run-after-cursor-issuance");
      // The Gateway samples run facts before awaiting its cursor worker.
      read.response.resolve(
        delta({
          ...idle,
          snapshotAt: 200,
          ...(rowKind === "previous-terminal" ? { lastRunId: "previous-run", status: "done" } : {}),
        }),
      );
      await refresh;
      expect(getChatHistoryLoadState(h.state).phase).toBe("committed");
      expect.soft(h.state.chatRunId).toBe(live.runId);
      expect.soft(h.state.chatStream).toBe(live.stream);
      expect.soft(h.state.toolStreamById.get(live.toolIdentity)).toBe(live.tool);
      expect.soft(isChatBusy(h.state)).toBe(true);
      expect.soft(hasAbortableSessionRun(h.state)).toBe(true);
      expect(h.state.chatRunStatus ?? null).toBeNull();
    } finally {
      await h.finish();
    }
  },
);

it("retires existing ghost custody from a fresh idle cursor without borrowing another run's outcome", async () => {
  const h = await fixture();
  try {
    const live = h.start("missed-terminal-run");
    const read = h.arm();
    const refresh = h.refresh();
    await read.issued.promise;
    read.response.resolve(
      delta({
        ...idle,
        snapshotAt: 200,
        lastRunId: "later-server-run",
        status: "failed",
        lastRunError: "Only the later run failed.",
      }),
    );
    await refresh;
    expect(h.state.chatRunId).toBeNull();
    expect(h.state.chatStream).toBeNull();
    expect(h.state.toolStreamById.has(live.toolIdentity)).toBe(false);
    expect(isChatBusy(h.state)).toBe(false);
    expect(h.state.chatRunStatus ?? null).toBeNull();
    expect(h.state.chatRunError ?? null).toBeNull();
  } finally {
    await h.finish();
  }
});

it.each(["retry", "reset-fallback"] as const)(
  "observes a run that started before the next history %s attempt",
  async (attempt) => {
    const h = await fixture();
    const retryRequested = createDeferred();
    const resumeRetry = createDeferred();
    const sleep = vi.spyOn(historyRetry, "sleep").mockImplementation(() => {
      retryRequested.resolve();
      return resumeRetry.promise;
    });
    try {
      const first = h.arm();
      const next = h.arm();
      const refresh = h.refresh();
      await first.issued.promise;
      const live = h.start("run-between-history-attempts");
      if (attempt === "retry") {
        first.response.reject(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "History is rebuilding",
            retryable: true,
            retryAfterMs: 250,
            details: { method: "chat.history" },
          }),
        );
        await retryRequested.promise;
        resumeRetry.resolve();
      } else {
        first.response.resolve({ kind: "reset" });
      }
      const [, params] = await next.issued.promise;
      const row = {
        ...idle,
        snapshotAt: 200,
        lastRunId: "later-run",
        status: "done",
      } satisfies GatewaySessionRow;
      if (attempt === "retry") {
        expect(params).toHaveProperty("cursor", "cursor-custody-before");
        next.response.resolve(delta(row));
      } else {
        expect(params).not.toHaveProperty("cursor");
        next.response.resolve(page(row));
      }
      await refresh;
      expect(h.state.chatRunId).toBeNull();
      expect(h.state.chatStream).toBeNull();
      expect(h.state.toolStreamById.has(live.toolIdentity)).toBe(false);
      expect(isChatBusy(h.state)).toBe(false);
      expect(h.state.chatRunStatus ?? null).toBeNull();
    } finally {
      resumeRetry.resolve();
      sleep.mockRestore();
      await h.finish();
    }
  },
);

it("does not transfer an already-issued cursor's custody to a later consumer", async () => {
  const h = await fixture();
  try {
    const first = h.mount(idle.key);
    const joining = h.mount(idle.key);
    await Promise.all([refreshPane(first), refreshPane(joining)]);
    await vi.dynamicImportSettled();
    expect(first.state.client).toBe(joining.state.client);
    expect(first.state.connectionEpoch).toBe(joining.state.connectionEpoch);
    expect(first.state.sessions).toBe(joining.state.sessions);
    const read = h.arm();
    const refreshFirst = h.refresh(first.state);
    await read.issued.promise;
    const live = h.start("run-before-late-consumer", first.state);
    const issuedCount = h.request.mock.calls.length;
    const refreshJoining = h.refresh(joining.state);
    expect(getChatHistoryLoadState(joining.state).phase).toBe("in-flight");
    expect(h.request.mock.calls.length).toBe(issuedCount);
    read.response.resolve(
      delta({ ...idle, snapshotAt: 200, lastRunId: "older-run", status: "done" }),
    );
    await Promise.all([refreshFirst, refreshJoining]);
    for (const state of [first.state, joining.state]) {
      expect.soft(state.chatRunId).toBe(live.runId);
      expect.soft(state.chatStream).toBe(live.stream);
      expect.soft(state.toolStreamById.has(live.toolIdentity)).toBe(true);
      expect.soft(isChatBusy(state)).toBe(true);
      expect(state.chatRunStatus ?? null).toBeNull();
    }
  } finally {
    await h.finish();
  }
});
