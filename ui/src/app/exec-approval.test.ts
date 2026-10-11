// @vitest-environment node
// Control UI tests cover exec approval behavior.
import { describe, expect, it, vi } from "vitest";
import {
  clearExecApprovalTimers,
  clearResolvedExecApprovalPrompt,
  enqueueExecApprovalPrompt,
  isStaleApprovalResolutionError,
  parseApprovalRequestedEvent,
  refreshPendingApprovalQueue,
  type ExecApprovalPromptState,
  type ExecApprovalRequest,
} from "./exec-approval.ts";

const parseExecApprovalRequested = (payload: unknown) =>
  parseApprovalRequestedEvent("exec.approval.requested", payload);
const parsePluginApprovalRequested = (payload: unknown) =>
  parseApprovalRequestedEvent("plugin.approval.requested", payload);
const parseSystemAgentApprovalRequested = (payload: unknown) =>
  parseApprovalRequestedEvent("openclaw.approval.requested", payload);

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createExecApproval(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "exec",
    request: { command: "echo hello" },
    createdAtMs: 1000,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

function createPromptState(
  request: RequestFn,
  queue: ExecApprovalRequest[] = [createExecApproval()],
): ExecApprovalPromptState {
  return {
    client: { request },
    execApprovalQueue: queue,
    execApprovalBusy: false,
    execApprovalErrors: new Map(),
  };
}

function createGatewayError(message: string, details?: unknown): Error {
  const err = new Error(message);
  Object.defineProperty(err, "gatewayCode", {
    value: "INVALID_REQUEST",
    enumerable: true,
  });
  Object.defineProperty(err, "details", {
    value: details,
    enumerable: true,
  });
  return err;
}

describe("parseExecApprovalRequested", () => {
  it("preserves allowed approval decisions", () => {
    const result = parseExecApprovalRequested({
      id: "exec-1",
      request: {
        command: "  pwd",
        runId: "engine-run-1",
        allowedDecisions: ["allow-once", "bad", "deny", "allow-always"],
      },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });

    expect(result).toMatchObject({
      kind: "exec",
      request: {
        command: "  pwd",
        runId: "engine-run-1",
        allowedDecisions: ["allow-once", "deny", "allow-always"],
      },
    });
  });
});

describe("parsePluginApprovalRequested", () => {
  // Matches the actual gateway broadcast shape: title/description/severity/pluginId
  // are nested inside payload.request (PluginApprovalRequestPayload)
  const validPayload = {
    id: "plugin-1",
    createdAtMs: 1000,
    expiresAtMs: 120_000,
    request: {
      title: "Dangerous command detected",
      description: "chmod 777 script.sh modifies file permissions",
      severity: "high",
      pluginId: "sage",
      agentId: "agent-1",
      sessionKey: "sess-1",
    },
  };

  it("returns null when title is missing from request", () => {
    const {
      request: { title: _, ...restRequest },
      ...rest
    } = validPayload;
    expect(parsePluginApprovalRequested({ ...rest, request: restRequest })).toBeNull();
  });

  it("returns null when request is missing entirely", () => {
    const { request: _, ...noRequest } = validPayload;
    expect(parsePluginApprovalRequested(noRequest)).toBeNull();
  });

  it("returns null when id is missing", () => {
    const { id: _, ...noId } = validPayload;
    expect(parsePluginApprovalRequested(noId)).toBeNull();
  });

  it("returns null when timestamps are missing", () => {
    const { createdAtMs: _, expiresAtMs: __, ...noTimestamps } = validPayload;
    expect(parsePluginApprovalRequested(noTimestamps)).toBeNull();
  });

  it("handles missing optional fields gracefully", () => {
    const minimal = {
      id: "plugin-2",
      createdAtMs: 500,
      expiresAtMs: 60_000,
      request: { title: "Alert" },
    };
    const result = parsePluginApprovalRequested(minimal);
    expect(result?.kind).toBe("plugin");
    expect(result?.pluginTitle).toBe("Alert");
    expect(result?.pluginDescription).toBeNull();
    expect(result?.pluginSeverity).toBeNull();
    expect(result?.pluginId).toBeNull();
    expect(result?.request.agentId).toBeNull();
    expect(result?.request.sessionKey).toBeNull();
  });
});

describe("parseSystemAgentApprovalRequested", () => {
  it("keeps the exact proposal and only safe prompt fields", () => {
    const result = parseSystemAgentApprovalRequested({
      id: "system-agent:1",
      createdAtMs: 1000,
      expiresAtMs: 2000,
      request: {
        title: "OpenClaw change",
        description: "Set gateway.port to 19001",
        command: "Set gateway.port to 19001",
        proposalHash: "a".repeat(64),
        agentId: "main",
        sessionKey: "agent:main:main",
        allowedDecisions: ["allow-once", "deny", "allow-always"],
      },
    });

    expect(result).toMatchObject({
      id: "system-agent:1",
      kind: "system-agent",
      pluginTitle: "OpenClaw change",
      pluginDescription: "Set gateway.port to 19001",
      proposalHash: "a".repeat(64),
      request: {
        command: "Set gateway.port to 19001",
        agentId: "main",
        sessionKey: "agent:main:main",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
  });
});

describe("parseExecApprovalRequested command spans", () => {
  it("rejects whitespace-only command text", () => {
    expect(
      parseExecApprovalRequested({
        id: "approval-blank-1",
        request: { command: "   " },
        createdAtMs: 1,
        expiresAtMs: 2,
      }),
    ).toBeNull();
  });

  it("preserves valid command spans from exec approval events", () => {
    const parsed = parseExecApprovalRequested({
      id: "approval-explain-1",
      request: {
        command: "ls | grep stuff",
        commandSpans: [
          { startIndex: 0, endIndex: 2 },
          { startIndex: 5, endIndex: 9 },
          { startIndex: 10, endIndex: 15 },
          { startIndex: 16, endIndex: 20 },
          { startIndex: -1, endIndex: 2 },
          { startIndex: 8, endIndex: 8 },
        ],
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(parsed?.request.commandSpans).toEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 5, endIndex: 9 },
      { startIndex: 10, endIndex: 15 },
    ]);
  });
});

describe("isStaleApprovalResolutionError", () => {
  it("detects missing approval errors", () => {
    expect(
      isStaleApprovalResolutionError(
        createGatewayError("approval not found", {
          reason: "APPROVAL_NOT_FOUND",
        }),
      ),
    ).toBe(true);
  });

  it("ignores unrelated approval resolve errors", () => {
    expect(isStaleApprovalResolutionError(createGatewayError("gateway unavailable"))).toBe(false);
  });
});

describe("approval queue ordering and countdown timer", () => {
  it("keeps newly received approvals oldest-first", () => {
    vi.useFakeTimers();
    try {
      const state = createPromptState(
        vi.fn<RequestFn>(async () => ({})),
        [],
      );
      enqueueExecApprovalPrompt(
        state,
        createExecApproval({ id: "approval-newer", createdAtMs: 2_000 }),
      );
      enqueueExecApprovalPrompt(
        state,
        createExecApproval({ id: "approval-oldest", createdAtMs: 1_000 }),
      );

      expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual([
        "approval-oldest",
        "approval-newer",
      ]);
      clearExecApprovalTimers(state);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish shared countdown ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));
    try {
      const state = createPromptState(
        vi.fn<RequestFn>(async () => ({})),
        [],
      );
      state.execApprovalExpiryTimers = new Map();
      state.execApprovalChanged = vi.fn();
      enqueueExecApprovalPrompt(state, createExecApproval({ expiresAtMs: Date.now() + 60_000 }));

      vi.advanceTimersByTime(1_000);
      expect(state.execApprovalChanged).not.toHaveBeenCalled();

      clearExecApprovalTimers(state);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("refreshPendingApprovalQueue", () => {
  it("keeps approvals received while a refresh is in flight", async () => {
    let resolveExecList: (value: unknown[]) => void = () => {};
    const execApprovalList = new Promise<unknown[]>((resolve) => {
      resolveExecList = resolve;
    });
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.list") {
        return execApprovalList;
      }
      if (method === "plugin.approval.list") {
        return [];
      }
      return {};
    });
    const state = createPromptState(request, []);

    const refreshPromise = refreshPendingApprovalQueue(state);
    enqueueExecApprovalPrompt(
      state,
      createExecApproval({ id: "approval-arrived-during-refresh", createdAtMs: 2000 }),
    );
    resolveExecList([]);
    await refreshPromise;

    expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual([
      "approval-arrived-during-refresh",
    ]);
    clearResolvedExecApprovalPrompt(state, "approval-arrived-during-refresh");
  });

  it("does not requeue approvals resolved while a refresh is in flight", async () => {
    let resolveExecList: (value: unknown[]) => void = () => {};
    const execApprovalList = new Promise<unknown[]>((resolve) => {
      resolveExecList = resolve;
    });
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.list") {
        return execApprovalList;
      }
      if (method === "plugin.approval.list") {
        return [];
      }
      return {};
    });
    const resolvingApproval = createExecApproval({ id: "approval-resolving" });
    const state = createPromptState(request, [resolvingApproval]);

    const refreshPromise = refreshPendingApprovalQueue(state);
    clearResolvedExecApprovalPrompt(state, "approval-resolving");
    resolveExecList([resolvingApproval]);
    await refreshPromise;

    expect(state.execApprovalQueue).toEqual([]);
  });

  it("does not requeue new approvals resolved before refresh completes", async () => {
    let resolveExecList: (value: unknown[]) => void = () => {};
    let resolvePluginList: (value: unknown[]) => void = () => {};
    const execApprovalList = new Promise<unknown[]>((resolve) => {
      resolveExecList = resolve;
    });
    const pluginApprovalList = new Promise<unknown[]>((resolve) => {
      resolvePluginList = resolve;
    });
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.list") {
        return execApprovalList;
      }
      if (method === "plugin.approval.list") {
        return pluginApprovalList;
      }
      return {};
    });
    const state = createPromptState(request, []);
    const transientApproval = createExecApproval({ id: "approval-transient" });

    const refreshPromise = refreshPendingApprovalQueue(state);
    enqueueExecApprovalPrompt(state, transientApproval);
    resolveExecList([transientApproval]);
    clearResolvedExecApprovalPrompt(state, "approval-transient");
    resolvePluginList([]);
    await refreshPromise;

    expect(state.execApprovalQueue).toEqual([]);
  });

  it("clears an expired approval's error without disturbing the queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));
    try {
      const activeExpiresAtMs = Date.now() + 1_000;
      const queuedExpiresAtMs = Date.now() + 60_000;
      const request = vi.fn<RequestFn>(async (method) => {
        if (method === "exec.approval.list") {
          return [
            {
              id: "approval-active-expiring",
              request: { command: "pnpm check:changed" },
              createdAtMs: Date.now(),
              expiresAtMs: activeExpiresAtMs,
            },
            {
              id: "approval-queued",
              request: { command: "pnpm test" },
              createdAtMs: Date.now() + 1,
              expiresAtMs: queuedExpiresAtMs,
            },
          ];
        }
        if (method === "plugin.approval.list") {
          return [];
        }
        return {};
      });
      const state = createPromptState(request, []);

      await refreshPendingApprovalQueue(state);
      state.execApprovalErrors.set(
        "approval-active-expiring",
        "Approval failed: Error: gateway unavailable",
      );

      vi.advanceTimersByTime(1_500);

      expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-queued"]);
      expect(state.execApprovalErrors.has("approval-active-expiring")).toBe(false);
      clearExecApprovalTimers(state);
    } finally {
      vi.useRealTimers();
    }
  });
});
