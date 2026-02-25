import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.js";
import { resetLogger, setLoggerOverride } from "../../logging.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { validateExecApprovalRequestParams } from "../protocol/index.js";
import { waitForAgentJob } from "./agent-job.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { sanitizeChatSendMessageInput } from "./chat.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import { logsHandlers } from "./logs.js";

vi.mock("../../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));

describe("waitForAgentJob", () => {
  it("maps lifecycle end events with aborted=true to timeout", async () => {
    const runId = `run-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 1_000 });

    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 100 } });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 200, aborted: true },
    });

    const snapshot = await waitPromise;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe("timeout");
    expect(snapshot?.startedAt).toBe(100);
    expect(snapshot?.endedAt).toBe(200);
  });

  it("keeps non-aborted lifecycle end events as ok", async () => {
    const runId = `run-ok-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 1_000 });

    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 300 } });
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", endedAt: 400 } });

    const snapshot = await waitPromise;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe("ok");
    expect(snapshot?.startedAt).toBe(300);
    expect(snapshot?.endedAt).toBe(400);
  });
});

describe("injectTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-29T01:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepends a compact timestamp matching formatZonedTimestamp", () => {
    const result = injectTimestamp("Is it the weekend?", {
      timezone: "America/New_York",
    });

    expect(result).toMatch(/^\[Wed 2026-01-28 20:30 EST\] Is it the weekend\?$/);
  });

  it("uses channel envelope format with DOW prefix", () => {
    const now = new Date();
    const expected = formatZonedTimestamp(now, { timeZone: "America/New_York" });

    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toBe(`[Wed ${expected}] hello`);
  });

  it("always uses 24-hour format", () => {
    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toContain("20:30");
    expect(result).not.toContain("PM");
    expect(result).not.toContain("AM");
  });

  it("uses the configured timezone", () => {
    const result = injectTimestamp("hello", { timezone: "America/Chicago" });

    expect(result).toMatch(/^\[Wed 2026-01-28 19:30 CST\]/);
  });

  it("defaults to UTC when no timezone specified", () => {
    const result = injectTimestamp("hello", {});

    expect(result).toMatch(/^\[Thu 2026-01-29 01:30/);
  });

  it("returns empty/whitespace messages unchanged", () => {
    expect(injectTimestamp("", { timezone: "UTC" })).toBe("");
    expect(injectTimestamp("   ", { timezone: "UTC" })).toBe("   ");
  });

  it("does NOT double-stamp messages with channel envelope timestamps", () => {
    const enveloped = "[Discord user1 2026-01-28 20:30 EST] hello there";
    const result = injectTimestamp(enveloped, { timezone: "America/New_York" });

    expect(result).toBe(enveloped);
  });

  it("does NOT double-stamp messages already injected by us", () => {
    const alreadyStamped = "[Wed 2026-01-28 20:30 EST] hello there";
    const result = injectTimestamp(alreadyStamped, { timezone: "America/New_York" });

    expect(result).toBe(alreadyStamped);
  });

  it("does NOT double-stamp messages with cron-injected timestamps", () => {
    const cronMessage =
      "[cron:abc123 my-job] do the thing\nCurrent time: Wednesday, January 28th, 2026 — 8:30 PM (America/New_York)";
    const result = injectTimestamp(cronMessage, { timezone: "America/New_York" });

    expect(result).toBe(cronMessage);
  });

  it("handles midnight correctly", () => {
    vi.setSystemTime(new Date("2026-02-01T05:00:00.000Z"));

    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toMatch(/^\[Sun 2026-02-01 00:00 EST\]/);
  });

  it("handles date boundaries (just before midnight)", () => {
    vi.setSystemTime(new Date("2026-02-01T04:59:00.000Z"));

    const result = injectTimestamp("hello", { timezone: "America/New_York" });

    expect(result).toMatch(/^\[Sat 2026-01-31 23:59 EST\]/);
  });

  it("handles DST correctly (same UTC hour, different local time)", () => {
    vi.setSystemTime(new Date("2026-01-15T05:00:00.000Z"));
    const winter = injectTimestamp("winter", { timezone: "America/New_York" });
    expect(winter).toMatch(/^\[Thu 2026-01-15 00:00 EST\]/);

    vi.setSystemTime(new Date("2026-07-15T04:00:00.000Z"));
    const summer = injectTimestamp("summer", { timezone: "America/New_York" });
    expect(summer).toMatch(/^\[Wed 2026-07-15 00:00 EDT\]/);
  });

  it("accepts a custom now date", () => {
    const customDate = new Date("2025-07-04T16:00:00.000Z");

    const result = injectTimestamp("fireworks?", {
      timezone: "America/New_York",
      now: customDate,
    });

    expect(result).toMatch(/^\[Fri 2025-07-04 12:00 EDT\]/);
  });
});

describe("timestampOptsFromConfig", () => {
  it("extracts timezone from config", () => {
    const opts = timestampOptsFromConfig({
      agents: {
        defaults: {
          userTimezone: "America/Chicago",
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    expect(opts.timezone).toBe("America/Chicago");
  });

  it("falls back gracefully with empty config", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const opts = timestampOptsFromConfig({} as any);

    expect(opts.timezone).toBeDefined();
  });
});

describe("normalizeRpcAttachmentsToChatAttachments", () => {
  it("passes through string content", () => {
    const res = normalizeRpcAttachmentsToChatAttachments([
      { type: "file", mimeType: "image/png", fileName: "a.png", content: "Zm9v" },
    ]);
    expect(res).toEqual([
      { type: "file", mimeType: "image/png", fileName: "a.png", content: "Zm9v" },
    ]);
  });

  it("converts Uint8Array content to base64", () => {
    const bytes = new TextEncoder().encode("foo");
    const res = normalizeRpcAttachmentsToChatAttachments([{ content: bytes }]);
    expect(res[0]?.content).toBe("Zm9v");
  });
});

describe("sanitizeChatSendMessageInput", () => {
  it("rejects null bytes", () => {
    expect(sanitizeChatSendMessageInput("before\u0000after")).toEqual({
      ok: false,
      error: "message must not contain null bytes",
    });
  });

  it("strips unsafe control characters while preserving tab/newline/carriage return", () => {
    const result = sanitizeChatSendMessageInput("a\u0001b\tc\nd\re\u0007f\u007f");
    expect(result).toEqual({ ok: true, message: "ab\tc\nd\ref" });
  });

  it("normalizes unicode to NFC", () => {
    expect(sanitizeChatSendMessageInput("Cafe\u0301")).toEqual({ ok: true, message: "Café" });
  });
});

describe("gateway chat transcript writes (guardrail)", () => {
  it("routes transcript writes through helper and SessionManager parentId append", () => {
    const chatTs = fileURLToPath(new URL("./chat.ts", import.meta.url));
    const chatSrc = fs.readFileSync(chatTs, "utf-8");
    const helperTs = fileURLToPath(new URL("./chat-transcript-inject.ts", import.meta.url));
    const helperSrc = fs.readFileSync(helperTs, "utf-8");

    expect(chatSrc.includes("fs.appendFileSync(transcriptPath")).toBe(false);
    expect(chatSrc).toContain("appendInjectedAssistantMessageToTranscript(");

    expect(helperSrc.includes("fs.appendFileSync(params.transcriptPath")).toBe(false);
    expect(helperSrc).toContain("SessionManager.open(params.transcriptPath)");
    expect(helperSrc).toContain("appendMessage(messageBody)");
  });
});

describe("exec approval handlers", () => {
  const execApprovalNoop = () => false;
  type ExecApprovalHandlers = ReturnType<typeof createExecApprovalHandlers>;
  type ExecApprovalRequestArgs = Parameters<ExecApprovalHandlers["exec.approval.request"]>[0];
  type ExecApprovalResolveArgs = Parameters<ExecApprovalHandlers["exec.approval.resolve"]>[0];

  const defaultExecApprovalRequestParams = {
    command: "echo ok",
    cwd: "/tmp",
    nodeId: "node-1",
    host: "node",
    timeoutMs: 2000,
  } as const;

  function toExecApprovalRequestContext(context: {
    broadcast: (event: string, payload: unknown) => void;
    hasExecApprovalClients?: () => boolean;
  }): ExecApprovalRequestArgs["context"] {
    return context as unknown as ExecApprovalRequestArgs["context"];
  }

  function toExecApprovalResolveContext(context: {
    broadcast: (event: string, payload: unknown) => void;
  }): ExecApprovalResolveArgs["context"] {
    return context as unknown as ExecApprovalResolveArgs["context"];
  }

  async function requestExecApproval(params: {
    handlers: ExecApprovalHandlers;
    respond: ReturnType<typeof vi.fn>;
    context: { broadcast: (event: string, payload: unknown) => void };
    params?: Record<string, unknown>;
  }) {
    const requestParams = {
      ...defaultExecApprovalRequestParams,
      ...params.params,
    } as unknown as ExecApprovalRequestArgs["params"];
    return params.handlers["exec.approval.request"]({
      params: requestParams,
      respond: params.respond as unknown as ExecApprovalRequestArgs["respond"],
      context: toExecApprovalRequestContext({
        hasExecApprovalClients: () => true,
        ...params.context,
      }),
      client: null,
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: execApprovalNoop,
    });
  }

  async function resolveExecApproval(params: {
    handlers: ExecApprovalHandlers;
    id: string;
    respond: ReturnType<typeof vi.fn>;
    context: { broadcast: (event: string, payload: unknown) => void };
  }) {
    return params.handlers["exec.approval.resolve"]({
      params: { id: params.id, decision: "allow-once" } as ExecApprovalResolveArgs["params"],
      respond: params.respond as unknown as ExecApprovalResolveArgs["respond"],
      context: toExecApprovalResolveContext(params.context),
      client: null,
      req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: execApprovalNoop,
    });
  }

  function createExecApprovalFixture() {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const respond = vi.fn();
    const context = {
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
      hasExecApprovalClients: () => true,
    };
    return { handlers, broadcasts, respond, context };
  }

  describe("ExecApprovalRequestParams validation", () => {
    it("accepts request with resolvedPath omitted", () => {
      const params = {
        command: "echo hi",
        cwd: "/tmp",
        nodeId: "node-1",
        host: "node",
      };
      expect(validateExecApprovalRequestParams(params)).toBe(true);
    });

    it("accepts request with resolvedPath as string", () => {
      const params = {
        command: "echo hi",
        cwd: "/tmp",
        nodeId: "node-1",
        host: "node",
        resolvedPath: "/usr/bin/echo",
      };
      expect(validateExecApprovalRequestParams(params)).toBe(true);
    });

    it("accepts request with resolvedPath as undefined", () => {
      const params = {
        command: "echo hi",
        cwd: "/tmp",
        nodeId: "node-1",
        host: "node",
        resolvedPath: undefined,
      };
      expect(validateExecApprovalRequestParams(params)).toBe(true);
    });

    it("accepts request with resolvedPath as null", () => {
      const params = {
        command: "echo hi",
        cwd: "/tmp",
        nodeId: "node-1",
        host: "node",
        resolvedPath: null,
      };
      expect(validateExecApprovalRequestParams(params)).toBe(true);
    });
  });

  it("rejects host=node approval requests without nodeId", async () => {
    const { handlers, respond, context } = createExecApprovalFixture();
    await requestExecApproval({
      handlers,
      respond,
      context,
      params: {
        nodeId: undefined,
      },
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "nodeId is required for host=node",
      }),
    );
  });

  it("broadcasts request + resolve", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: { twoPhase: true },
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).not.toBe("");

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "accepted", id }),
      undefined,
    );

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      handlers,
      id,
      respond: resolveRespond,
      context,
    });

    await requestPromise;

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id, decision: "allow-once" }),
      undefined,
    );
    expect(broadcasts.some((entry) => entry.event === "exec.approval.resolved")).toBe(true);
  });

  it("accepts resolve during broadcast", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const respond = vi.fn();
    const resolveRespond = vi.fn();

    const resolveContext = {
      broadcast: () => {},
    };

    const context = {
      broadcast: (event: string, payload: unknown) => {
        if (event !== "exec.approval.requested") {
          return;
        }
        const id = (payload as { id?: string })?.id ?? "";
        void resolveExecApproval({
          handlers,
          id,
          respond: resolveRespond,
          context: resolveContext,
        });
      },
    };

    await requestExecApproval({
      handlers,
      respond,
      context,
    });

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: "allow-once" }),
      undefined,
    );
  });

  it("accepts explicit approval ids", async () => {
    const { handlers, broadcasts, respond, context } = createExecApprovalFixture();

    const requestPromise = requestExecApproval({
      handlers,
      respond,
      context,
      params: { id: "approval-123", host: "gateway" },
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).toBe("approval-123");

    const resolveRespond = vi.fn();
    await resolveExecApproval({
      handlers,
      id,
      respond: resolveRespond,
      context,
    });

    await requestPromise;
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-123", decision: "allow-once" }),
      undefined,
    );
    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("expires immediately when no approver clients and no forwarding targets", async () => {
    vi.useFakeTimers();
    try {
      const manager = new ExecApprovalManager();
      const forwarder = {
        handleRequested: vi.fn(async () => false),
        handleResolved: vi.fn(async () => {}),
        stop: vi.fn(),
      };
      const handlers = createExecApprovalHandlers(manager, { forwarder });
      const respond = vi.fn();
      const context = {
        broadcast: (_event: string, _payload: unknown) => {},
        hasExecApprovalClients: () => false,
      };
      const expireSpy = vi.spyOn(manager, "expire");

      const requestPromise = requestExecApproval({
        handlers,
        respond,
        context,
        params: { timeoutMs: 60_000 },
      });
      for (let idx = 0; idx < 20; idx += 1) {
        await Promise.resolve();
      }
      expect(forwarder.handleRequested).toHaveBeenCalledTimes(1);
      expect(expireSpy).toHaveBeenCalledTimes(1);
      await vi.runOnlyPendingTimersAsync();
      await requestPromise;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ decision: null }),
        undefined,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("gateway healthHandlers.status scope handling", () => {
  let statusModule: typeof import("../../commands/status.js");
  let healthHandlers: typeof import("./health.js").healthHandlers;

  beforeAll(async () => {
    statusModule = await import("../../commands/status.js");
    ({ healthHandlers } = await import("./health.js"));
  });

  beforeEach(() => {
    vi.mocked(statusModule.getStatusSummary).mockClear();
  });

  async function runHealthStatus(scopes: string[]) {
    const respond = vi.fn();

    await healthHandlers.status({
      req: {} as never,
      params: {} as never,
      respond: respond as never,
      context: {} as never,
      client: { connect: { role: "operator", scopes } } as never,
      isWebchatConnect: () => false,
    });

    return respond;
  }

  it.each([
    { scopes: ["operator.read"], includeSensitive: false },
    { scopes: ["operator.admin"], includeSensitive: true },
  ])(
    "requests includeSensitive=$includeSensitive for scopes $scopes",
    async ({ scopes, includeSensitive }) => {
      const respond = await runHealthStatus(scopes);

      expect(vi.mocked(statusModule.getStatusSummary)).toHaveBeenCalledWith({ includeSensitive });
      expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    },
  );
});

describe("logs.tail", () => {
  const logsNoop = () => false;

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  it("falls back to latest rolling log file when today is missing", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-logs-"));
    const older = path.join(tempDir, "openclaw-2026-01-20.log");
    const newer = path.join(tempDir, "openclaw-2026-01-21.log");

    await fsPromises.writeFile(older, '{"msg":"old"}\n');
    await fsPromises.writeFile(newer, '{"msg":"new"}\n');
    await fsPromises.utimes(older, new Date(0), new Date(0));
    await fsPromises.utimes(newer, new Date(), new Date());

    setLoggerOverride({ file: path.join(tempDir, "openclaw-2026-01-22.log") });

    const respond = vi.fn();
    await logsHandlers["logs.tail"]({
      params: {},
      respond,
      context: {} as unknown as Parameters<(typeof logsHandlers)["logs.tail"]>[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "logs.tail" },
      isWebchatConnect: logsNoop,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        file: newer,
        lines: ['{"msg":"new"}'],
      }),
      undefined,
    );

    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });
});
