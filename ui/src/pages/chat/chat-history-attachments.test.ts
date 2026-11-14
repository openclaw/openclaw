// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  readChatTranscriptAttachmentSource,
  resetChatHistoryProjection,
} from "./chat-history-state.ts";
import { createState } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { projectTranscriptAttachments } from "./components/chat-transcript-attachments.ts";

it.each(["empty", "populated", "partial"] as const)(
  "retains accepted %s attachment coverage during history refresh, not initial load or reset",
  async (kind) => {
    const history: ChatHistoryResult = {
      sessionId: "attachment-session",
      messages:
        kind === "populated"
          ? [
              {
                role: "user",
                content: "",
                __openclaw: {
                  media: [
                    { url: "media://inbound/report.pdf", kind: "document", fileName: "report.pdf" },
                  ],
                },
              },
            ]
          : [],
      hasMore: kind === "partial",
    };
    const state = createState(history);
    const initial = createDeferred<ChatHistoryResult>();
    const refresh = createDeferred<ChatHistoryResult>();
    const request = vi
      .spyOn(state.client!, "request")
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise);
    const read = () =>
      projectTranscriptAttachments(readChatTranscriptAttachmentSource(state), {}, () => {});
    const loading = loadChatHistory(state);
    expect(read()).toMatchObject({ loading: true, coverage: "unknown" });
    initial.resolve(history);
    await loading;
    const accepted = read();
    expect(accepted.entries).toHaveLength(kind === "populated" ? 1 : 0);
    expect(accepted).toMatchObject({
      loading: false,
      coverage: kind === "partial" ? "partial" : "complete",
    });

    const refreshing = loadChatHistory(state);
    try {
      const refreshingAttachments = read();
      expect(refreshingAttachments).toMatchObject({
        loading: false,
        coverage: kind === "partial" ? "partial" : "complete",
      });
      expect(refreshingAttachments.entries.map((entry) => entry.label)).toEqual(
        kind === "populated" ? ["report.pdf"] : [],
      );
    } finally {
      refresh.resolve(history);
      await refreshing;
    }
    const failed = createDeferred<ChatHistoryResult>();
    request.mockReturnValueOnce(failed.promise);
    const failing = loadChatHistory(state);
    failed.reject(new Error("Access denied"));
    await failing;
    expect(read().error).toContain("Access denied");

    resetChatHistoryProjection(state);
    const replacement = createDeferred<ChatHistoryResult>();
    request.mockReturnValueOnce(replacement.promise);
    const replacing = loadChatHistory(state);
    try {
      expect(read()).toMatchObject({ loading: true, coverage: "unknown", entries: [] });
    } finally {
      replacement.resolve({ ...history, messages: [] });
      await replacing;
    }
  },
);

it.each(["session", "epoch", "agent"] as const)(
  "does not reuse accepted attachment coverage after a %s replacement",
  async (scope) => {
    const history = { messages: [], sessionId: "attachment-session" };
    const state = createState(history);
    state.sessionKey = scope === "agent" ? "global" : "main";
    state.assistantAgentId = "main";
    await loadChatHistory(state);
    expect(readChatTranscriptAttachmentSource(state).coverage).toBe("complete");
    if (scope === "session") {
      state.sessionKey = "agent:main:other";
    }
    if (scope === "epoch") {
      state.connectionEpoch++;
    }
    if (scope === "agent") {
      state.assistantAgentId = "other";
    }
    const response = createDeferred<typeof history>();
    vi.spyOn(state.client!, "request").mockReturnValueOnce(response.promise);
    const pending = loadChatHistory(state);
    try {
      expect(readChatTranscriptAttachmentSource(state)).toMatchObject({
        coverage: "unknown",
        loading: true,
      });
    } finally {
      response.resolve(history);
      await pending;
    }
  },
);
