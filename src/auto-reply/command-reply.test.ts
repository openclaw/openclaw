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
      commandRunner: vi.fn(),
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
      commandRunner: vi.fn(),
      enqueue: enqueueImmediate,
    });

    const call = rpcMock.mock.calls[0]?.[0];
    expect(call?.prompt).toBe("hello");
    expect(
      (call?.argv ?? []).some((arg: string) => arg.includes("hello")),
    ).toBe(false);
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
      commandRunner: vi.fn(),
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
      commandRunner: vi.fn(),
      enqueue: enqueueImmediate,
    });

    const payload = payloads?.[0];
    expect(payload?.text).toContain("Command timed out after 1s");
    expect(payload?.text).toContain("partial output");
    expect(meta.killed).toBe(true);
  });

  it("parses MEDIA tokens and respects mediaMaxMb for local files", async () => {
    const tmp = path.join(os.tmpdir(), `warelay-test-${Date.now()}.bin`);
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
      commandRunner: vi.fn(),
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
      commandRunner: vi.fn(),
      enqueue: enqueueImmediate,
    });

    expect(meta.queuedMs).toBe(25);
    expect(meta.queuedAhead).toBe(2);
    expect((meta.agentMeta?.usage as { output?: number })?.output).toBe(5);
  });
});
