// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";

afterEach(() => {
  vi.doUnmock("./chat-history-actions.runtime.ts");
  vi.unstubAllGlobals();
});

async function heldActions(takeoverAtEntry?: "route" | "physical") {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const load = createDeferred();
  const started = createDeferred();
  vi.doMock("./chat-history-actions.runtime.ts", async (original) => {
    started.resolve();
    await load.promise;
    const runtime = await original<typeof import("./chat-history-actions.runtime.ts")>();
    if (!takeoverAtEntry) {
      return runtime;
    }
    const takeOver = (state: { sessionKey: string; currentSessionId?: string | null }) => {
      if (takeoverAtEntry === "physical") {
        state.currentSessionId = "successor-physical";
      } else {
        state.sessionKey = "agent:main:successor";
      }
    };
    return {
      ...runtime,
      clearChatHistory: (operation: Parameters<typeof runtime.clearChatHistory>[0]) => {
        takeOver(operation.state);
        return runtime.clearChatHistory(operation);
      },
      rewindChatHistory: (operation: Parameters<typeof runtime.rewindChatHistory>[0]) => {
        takeOver(operation.state);
        return runtime.rewindChatHistory(operation);
      },
      switchChatHistoryBranch: (
        operation: Parameters<typeof runtime.switchChatHistoryBranch>[0],
      ) => {
        takeOver(operation.state);
        return runtime.switchChatHistoryBranch(operation);
      },
    };
  });
  const { makeChatHost } = await import("./chat-host.test-support.ts");
  const actions = await import("./chat-history-actions.ts");
  const { ChatAttachmentReadLifecycle } = await import("./components/chat-attachment-reads.ts");
  const { handleChatDraftChange } = await import("./input-history.ts");
  const state = Object.assign(
    makeChatHost({
      sessionKey: "agent:main:source",
      requestHandlers: { "chat.history": { messages: [] } },
    }),
    {
      chatError: null,
      handleChatDraftChange: (text: string) => handleChatDraftChange(state, text),
    },
  );
  const reset = vi.spyOn(state.sessions, "reset").mockResolvedValue("completed");
  const rewind = vi.spyOn(state.sessions, "rewind").mockResolvedValue({ editorText: "restored" });
  const branch = vi.spyOn(state.sessions, "switchBranch").mockResolvedValue({});
  vi.spyOn(state.sessions, "listBranches").mockResolvedValue([]);
  const reads = new ChatAttachmentReadLifecycle(() => {});
  return { actions, state, reset, rewind, branch, reads, load, started };
}

it.each(["clear", "rewind", "switch"] as const)(
  "does not issue a cold %s against a successor route",
  async (action) => {
    const fixture = await heldActions();
    const { actions, state, load, reads, reset, rewind, branch, started } = fixture;
    try {
      const pending =
        action === "clear"
          ? actions.clearChatHistory(state)
          : action === "rewind"
            ? actions.rewindChatHistory(state, "original", reads)
            : actions.switchChatHistoryBranch(state, "branch");
      await started.promise;
      state.sessionKey = "agent:main:successor";
      load.resolve();
      expect(await pending).toBe(
        action === "clear" ? "failed" : action === "rewind" ? null : false,
      );
      expect(reset).not.toHaveBeenCalled();
      expect(rewind).not.toHaveBeenCalled();
      expect(branch).not.toHaveBeenCalled();
      expect(state.chatError).toBeNull();
    } finally {
      state.sessions.dispose();
    }
  },
);

it.each(["clear", "rewind", "switch"] as const)(
  "does not issue a cold %s against a successor physical session at the same key",
  async (action) => {
    const { actions, state, load, reads, reset, rewind, branch, started } = await heldActions();
    try {
      state.currentSessionId = "original-physical";
      const pending =
        action === "clear"
          ? actions.clearChatHistory(state)
          : action === "rewind"
            ? actions.rewindChatHistory(state, "original", reads)
            : actions.switchChatHistoryBranch(state, "branch");
      await started.promise;
      state.currentSessionId = "successor-physical";
      load.resolve();
      expect(await pending).toBe(
        action === "clear" ? "failed" : action === "rewind" ? null : false,
      );
      expect(reset).not.toHaveBeenCalled();
      expect(rewind).not.toHaveBeenCalled();
      expect(branch).not.toHaveBeenCalled();
      expect(state.chatError).toBeNull();
    } finally {
      state.sessions.dispose();
    }
  },
);

it.each(["clear", "rewind", "switch"] as const)(
  "allows a cold %s when the initially unknown physical identity resolves",
  async (action) => {
    const { actions, state, load, reads, reset, rewind, branch, started } = await heldActions();
    try {
      state.currentSessionId = null;
      const pending =
        action === "clear"
          ? actions.clearChatHistory(state)
          : action === "rewind"
            ? actions.rewindChatHistory(state, "original", reads)
            : actions.switchChatHistoryBranch(state, "branch");
      await started.promise;
      state.currentSessionId = "resolved-physical";
      load.resolve();
      expect(await pending).toEqual(
        action === "clear" ? "completed" : action === "rewind" ? { editorText: "restored" } : true,
      );
      expect(
        action === "clear" ? reset : action === "rewind" ? rewind : branch,
      ).toHaveBeenCalledOnce();
    } finally {
      state.sessions.dispose();
    }
  },
);

it.each(["clear", "rewind", "switch"] as const)(
  "rechecks a newly resolved physical owner at the %s execution entry",
  async (action) => {
    const { actions, state, load, reads, reset, rewind, branch, started } =
      await heldActions("physical");
    try {
      state.currentSessionId = null;
      const pending =
        action === "clear"
          ? actions.clearChatHistory(state)
          : action === "rewind"
            ? actions.rewindChatHistory(state, "original", reads)
            : actions.switchChatHistoryBranch(state, "branch");
      await started.promise;
      state.currentSessionId = "resolved-physical";
      load.resolve();
      expect(await pending).toBe(
        action === "clear" ? "failed" : action === "rewind" ? null : false,
      );
      expect(state.currentSessionId).toBe("successor-physical");
      expect(reset).not.toHaveBeenCalled();
      expect(rewind).not.toHaveBeenCalled();
      expect(branch).not.toHaveBeenCalled();
      expect(state.chatError).toBeNull();
    } finally {
      state.sessions.dispose();
    }
  },
);

it.each(["clear", "rewind", "switch"] as const)(
  "rechecks the %s execution owner after its module resolves",
  async (action) => {
    const { actions, state, load, reads, reset, rewind, branch, started } =
      await heldActions("route");
    try {
      const pending =
        action === "clear"
          ? actions.clearChatHistory(state)
          : action === "rewind"
            ? actions.rewindChatHistory(state, "original", reads)
            : actions.switchChatHistoryBranch(state, "branch");
      await started.promise;
      load.resolve();
      expect(await pending).toBe(
        action === "clear" ? "failed" : action === "rewind" ? null : false,
      );
      expect(state.sessionKey).toBe("agent:main:successor");
      expect(reset).not.toHaveBeenCalled();
      expect(rewind).not.toHaveBeenCalled();
      expect(branch).not.toHaveBeenCalled();
    } finally {
      state.sessions.dispose();
    }
  },
);

it.each(["completed", "uncertain"] as const)(
  "reconciles %s clear after its issued reset changes the physical session",
  async (result) => {
    const { actions, state, load, reset, started } = await heldActions();
    try {
      state.currentSessionId = "original-physical";
      reset.mockImplementation(async () => {
        state.currentSessionId = "reset-physical";
        return result;
      });
      const pending = actions.clearChatHistory(state);
      await started.promise;
      load.resolve();
      expect(await pending).toBe(result);
      expect(reset).toHaveBeenCalledOnce();
      if (result === "uncertain") {
        expect(state.chatError).toContain("Current history was refreshed");
      }
    } finally {
      state.sessions.dispose();
    }
  },
);

it("captures the rewind composer and attachment generation before loading", async () => {
  const { actions, state, reads, load, rewind, started } = await heldActions();
  try {
    state.chatMessage = "old draft";
    const signal = reads.readSignal;
    const pending = actions.rewindChatHistory(state, "original", reads);
    await started.promise;
    state.handleChatDraftChange("new draft");
    reads.abortReads();
    const replacement = reads.readSignal;
    load.resolve();
    expect(await pending).toBeNull();
    expect(rewind).toHaveBeenCalledWith("agent:main:source", "original", {});
    expect(state.chatMessage).toBe("new draft");
    expect(signal.aborted).toBe(true);
    expect(replacement.aborted).toBe(false);
  } finally {
    state.sessions.dispose();
  }
});

it("does not retire a newer initial submission while a cold clear loads", async () => {
  const { actions, state, load, reset, started } = await heldActions();
  const { buildInitialChatSubmission } = await import("./user-message-content.ts");
  const client = state.client;
  if (!client) {
    throw new Error("Expected a connected client");
  }
  const original = buildInitialChatSubmission(
    state.sessionKey,
    { text: "original", createdAt: 1 },
    client,
    "original-run",
  );
  const newer = buildInitialChatSubmission(
    state.sessionKey,
    { text: "newer", createdAt: 2 },
    client,
    "newer-run",
  );
  if (!original || !newer) {
    throw new Error("Expected initial submissions");
  }
  try {
    state.chatSubmissions.retain(original);
    state.chatRunId = "original-run";
    const pending = actions.clearChatHistory(state);
    await started.promise;
    state.chatSubmissions.retain(newer);
    state.chatRunId = "newer-run";
    load.resolve();
    expect(await pending).toBe("completed");
    expect(reset).toHaveBeenCalledWith("agent:main:source", {});
    expect(state.chatSubmissions.readInitial(state.sessionKey, client)).toMatchObject({
      pending: true,
      message: newer.message,
    });
  } finally {
    state.sessions.dispose();
  }
});

it.each(["clear", "rewind", "switch"] as const)(
  "reports a cold %s loader failure without issuing a mutation",
  async (action) => {
    const { actions, state, load, reads, reset, rewind, branch, started } = await heldActions();
    try {
      const pending =
        action === "clear"
          ? actions.clearChatHistory(state)
          : action === "rewind"
            ? actions.rewindChatHistory(state, "original", reads)
            : actions.switchChatHistoryBranch(state, "branch");
      await started.promise;
      load.reject(new Error("History action could not load"));
      expect(await pending).toBe(
        action === "clear" ? "failed" : action === "rewind" ? null : false,
      );
      expect(state.chatError).toContain("History action could not load");
      expect(reset).not.toHaveBeenCalled();
      expect(rewind).not.toHaveBeenCalled();
      expect(branch).not.toHaveBeenCalled();
    } finally {
      state.sessions.dispose();
    }
  },
);
