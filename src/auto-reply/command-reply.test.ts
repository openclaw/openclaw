import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as tauRpc from "../process/tau-rpc.js";
import { runCommandReply } from "./command-reply.js";

const noopTemplateCtx = {
  Body: "hello",
  BodyStripped: "hello",
  SessionId: "sess",
  IsNewSession: "true",
};

const enqueueImmediate = vi.fn(
  async <T>(
    task: () => Promise<T>,
    opts?: { onWait?: (ms: number, ahead: number) => void },
  ) => {
    opts?.onWait?.(25, 2);
    return task();
  },
);

function mockPiRpc(result: {
  stdout: string;
  stderr?: string;
  code: number;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
}) {
  return vi
    .spyOn(tauRpc, "runPiRpc")
    .mockResolvedValue({ killed: false, signal: null, ...result });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCommandReply (pi)", () => {
  it("injects pi flags and forwards prompt via RPC", async () => {
    const rpcMock = mockPiRpc({
      stdout:
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      stderr: "",
      code: 0,
    });

    const { payloads } = await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "{{Body}}"],
        agent: { kind: "pi", format: "json" },
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
      thinkLevel: "medium",
    });

    const payload = payloads?.[0];
    expect(payload?.text).toBe("ok");

    const call = rpcMock.mock.calls[0]?.[0];
    expect(call?.prompt).toBe("hello");
    expect(call?.argv).toContain("-p");
    expect(call?.argv).toContain("--mode");
    expect(call?.argv).toContain("rpc");
    expect(call?.argv).toContain("--thinking");
    expect(call?.argv).toContain("medium");
  });

  it("sends the body via RPC even when the command omits {{Body}}", async () => {
    const rpcMock = mockPiRpc({
      stdout:
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      stderr: "",
      code: 0,
    });

    await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "--mode", "rpc", "--session", "/tmp/demo.jsonl"],
        agent: { kind: "pi" },
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
    });

    const call = rpcMock.mock.calls[0]?.[0];
    expect(call?.prompt).toBe("hello");
    expect(
      (call?.argv ?? []).some((arg: string) => arg.includes("hello")),
    ).toBe(false);
  });

  it("does not echo the user's prompt when the agent returns no assistant text", async () => {
    const rpcMock = mockPiRpc({
      stdout: [
        '{"type":"agent_start"}',
        '{"type":"turn_start"}',
        '{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
        '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
        // assistant emits nothing useful
        '{"type":"agent_end"}',
      ].join("\n"),
      stderr: "",
      code: 0,
    });

    const { payloads } = await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "{{Body}}"],
        agent: { kind: "pi" },
      },
      templatingCtx: {
        ...noopTemplateCtx,
        Body: "hello",
        BodyStripped: "hello",
      },
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
    });

    expect(rpcMock).toHaveBeenCalledOnce();
    expect(payloads?.length).toBe(1);
    expect(payloads?.[0]?.text).toMatch(/no output/i);
    expect(payloads?.[0]?.text).not.toContain("hello");
  });

  it("does not echo the prompt even when the fallback text matches after stripping prefixes", async () => {
    const rpcMock = mockPiRpc({
      stdout: [
        '{"type":"agent_start"}',
        '{"type":"turn_start"}',
        '{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"[Dec 5 22:52] https://example.com"}]}}',
        '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"[Dec 5 22:52] https://example.com"}]}}',
        // No assistant content
        '{"type":"agent_end"}',
      ].join("\n"),
      stderr: "",
      code: 0,
    });

    const { payloads } = await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "{{Body}}"],
        agent: { kind: "pi" },
      },
      templatingCtx: {
        ...noopTemplateCtx,
        Body: "[Dec 5 22:52] https://example.com",
        BodyStripped: "[Dec 5 22:52] https://example.com",
      },
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
    });

    expect(rpcMock).toHaveBeenCalledOnce();
    expect(payloads?.length).toBe(1);
    expect(payloads?.[0]?.text).toMatch(/no output/i);
    expect(payloads?.[0]?.text).not.toContain("example.com");
  });

  it("forwards tool events even when verbose is off", async () => {
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];

    vi.spyOn(tauRpc, "runPiRpc").mockImplementation(
      async (opts: Parameters<typeof tauRpc.runPiRpc>[0]) => {
        opts.onEvent?.(
          JSON.stringify({
            type: "tool_execution_start",
            toolName: "bash",
            toolCallId: "call-1",
            args: { cmd: "echo 1" },
          }),
        );
        opts.onEvent?.(
          JSON.stringify({
            type: "message",
            message: {
              role: "tool_result",
              toolCallId: "call-1",
              content: [{ type: "text", text: "ok" }],
            },
          }),
        );
        return {
          stdout:
            '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
          stderr: "",
          code: 0,
          killed: false,
          signal: null,
        };
      },
    );

    await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "{{Body}}"],
        agent: { kind: "pi" },
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
      onAgentEvent: (evt) => events.push(evt),
    });

    expect(events).toContainEqual({
      stream: "tool",
      data: expect.objectContaining({
        phase: "start",
        name: "bash",
        toolCallId: "call-1",
      }),
    });
    expect(events).toContainEqual({
      stream: "tool",
      data: expect.objectContaining({ phase: "result", toolCallId: "call-1" }),
    });
  });

  it("adds session args and --continue when resuming", async () => {
    const rpcMock = mockPiRpc({
      stdout:
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      stderr: "",
      code: 0,
    });

    await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "{{Body}}"],
        agent: { kind: "pi" },
        session: {},
      },
      templatingCtx: { ...noopTemplateCtx, SessionId: "abc" },
      sendSystemOnce: true,
      isNewSession: false,
      isFirstTurnInSession: false,
      systemSent: true,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
    });

    const argv = rpcMock.mock.calls[0]?.[0]?.argv ?? [];
    expect(argv).toContain("--session");
    expect(argv.some((a) => a.includes("abc"))).toBe(true);
    expect(argv).toContain("--continue");
  });

  it("returns timeout text with partial snippet", async () => {
    vi.spyOn(tauRpc, "runPiRpc").mockRejectedValue({
      stdout: "partial output here",
      killed: true,
      signal: "SIGKILL",
    });

    const { payloads, meta } = await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "hi"],
        agent: { kind: "pi" },
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 10,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
    });

    const payload = payloads?.[0];
    expect(payload?.text).toContain("Command timed out after 1s");
    expect(payload?.text).toContain("partial output");
    expect(meta.killed).toBe(true);
  });

  it("collapses rpc deltas instead of emitting raw JSON spam", async () => {
    mockPiRpc({
      stdout: [
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}',
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":" world"}}',
      ].join("\n"),
      stderr: "",
      code: 0,
    });

    const { payloads } = await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "{{Body}}"],
        agent: { kind: "pi" },
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
    });

    expect(payloads?.[0]?.text).toBe("Hello world");
  });

  it("falls back to assistant text when parseOutput yields nothing", async () => {
    mockPiRpc({
      stdout: [
        '{"type":"agent_start"}',
        '{"type":"turn_start"}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Acknowledged."}]}}',
      ].join("\n"),
      stderr: "",
      code: 0,
    });
    // Force parser to return nothing so we exercise fallback.
    const parseSpy = vi
      .spyOn((await import("../agents/pi.js")).piSpec, "parseOutput")
      .mockReturnValue({ texts: [], toolResults: [], meta: undefined });

    const { payloads } = await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "{{Body}}"],
        agent: { kind: "pi" },
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
    });

    parseSpy.mockRestore();
    expect(payloads?.[0]?.text).toBe("Acknowledged.");
  });

  it("does not stream tool results when verbose is off", async () => {
    const onPartial = vi.fn();
    mockPiRpc({
      stdout: [
        '{"type":"tool_execution_start","toolName":"bash","args":{"command":"ls"}}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
      ].join("\n"),
      stderr: "",
      code: 0,
    });

    await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "{{Body}}"],
        agent: { kind: "pi" },
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
      onPartialReply: onPartial,
      verboseLevel: "off",
    });

    expect(onPartial).not.toHaveBeenCalled();
  });

  it("parses MEDIA tokens and respects mediaMaxMb for local files", async () => {
    const tmp = path.join(os.tmpdir(), `clawdis-test-${Date.now()}.bin`);
    const bigBuffer = Buffer.alloc(2 * 1024 * 1024, 1);
    await fs.writeFile(tmp, bigBuffer);

    mockPiRpc({
      stdout: `hi\nMEDIA:${tmp}\nMEDIA:https://example.com/img.jpg`,
      stderr: "",
      code: 0,
    });

    const { payloads } = await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "hi"],
        mediaMaxMb: 1,
        agent: { kind: "pi" },
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 1000,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
    });

    const payload = payloads?.[0];
    expect(payload?.mediaUrls).toEqual(["https://example.com/img.jpg"]);
    await fs.unlink(tmp);
  });

  it("captures queue wait metrics and agent meta", async () => {
    mockPiRpc({
      stdout:
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input":10,"output":5}}}',
      stderr: "",
      code: 0,
    });

    const { meta } = await runCommandReply({
      reply: {
        mode: "command",
        command: ["pi", "{{Body}}"],
        agent: { kind: "pi" },
      },
      templatingCtx: noopTemplateCtx,
      sendSystemOnce: false,
      isNewSession: true,
      isFirstTurnInSession: true,
      systemSent: false,
      timeoutMs: 100,
      timeoutSeconds: 1,
      enqueue: enqueueImmediate,
    });

    expect(meta.queuedMs).toBe(25);
    expect(meta.queuedAhead).toBe(2);
    expect((meta.agentMeta?.usage as { output?: number })?.output).toBe(5);
  });
});
