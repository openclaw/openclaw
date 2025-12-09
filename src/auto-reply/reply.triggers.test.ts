import { afterEach, describe, expect, it, vi } from "vitest";

import * as tauRpc from "../process/tau-rpc.js";
import * as commandReply from "./command-reply.js";
import { getReplyFromConfig } from "./reply.js";

const webMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

vi.mock("../web/session.js", () => webMocks);

const baseCfg = {
  inbound: {
    reply: {
      mode: "command" as const,
      command: ["echo", "{{Body}}"],
      session: undefined,
    },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trigger handling", () => {
  it("aborts even with timestamp prefix", async () => {
    const commandSpy = vi.spyOn(commandReply, "runCommandReply");
    const res = await getReplyFromConfig(
      {
        Body: "[Dec 5 10:00] stop",
        From: "+1000",
        To: "+2000",
      },
      {},
      baseCfg,
    );
    const text = Array.isArray(res) ? res[0]?.text : res?.text;
    expect(text).toBe("⚙️ Agent was aborted.");
    expect(commandSpy).not.toHaveBeenCalled();
  });

  it("restarts even with prefix/whitespace", async () => {
    const commandSpy = vi.spyOn(commandReply, "runCommandReply");
    const res = await getReplyFromConfig(
      {
        Body: "  [Dec 5] /restart",
        From: "+1001",
        To: "+2000",
      },
      {},
      baseCfg,
    );
    const text = Array.isArray(res) ? res[0]?.text : res?.text;
    expect(text?.startsWith("⚙️ Restarting" ?? "")).toBe(true);
    expect(commandSpy).not.toHaveBeenCalled();
  });

  it("reports status without invoking the agent", async () => {
    const commandSpy = vi.spyOn(commandReply, "runCommandReply");
    const res = await getReplyFromConfig(
      {
        Body: "/status",
        From: "+1002",
        To: "+2000",
      },
      {},
      baseCfg,
    );
    const text = Array.isArray(res) ? res[0]?.text : res?.text;
    expect(text).toContain("Status");
    expect(commandSpy).not.toHaveBeenCalled();
  });

  it("ignores think directives that only appear in the context wrapper", async () => {
    const rpcMock = vi.spyOn(tauRpc, "runPiRpc").mockResolvedValue({
      stdout:
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    const res = await getReplyFromConfig(
      {
        Body: [
          "[Chat messages since your last reply - for context]",
          "Peter: /thinking high [2025-12-05T21:45:00.000Z]",
          "",
          "[Current message - respond to this]",
          "Give me the status",
        ].join("\n"),
        From: "+1002",
        To: "+2000",
      },
      {},
      baseCfg,
    );

    const text = Array.isArray(res) ? res[0]?.text : res?.text;
    expect(text).toBe("ok");
    expect(rpcMock).toHaveBeenCalledOnce();
    const prompt = rpcMock.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("Give me the status");
    expect(prompt).not.toContain("/thinking high");
  });

  it("does not emit directive acks for heartbeats with /think", async () => {
    const rpcMock = vi.spyOn(tauRpc, "runPiRpc").mockResolvedValue({
      stdout:
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    const res = await getReplyFromConfig(
      {
        Body: "HEARTBEAT /think:high",
        From: "+1003",
        To: "+1003",
      },
      { isHeartbeat: true },
      {
        inbound: {
          reply: {
            mode: "command",
            command: ["pi", "{{Body}}"],
            agent: { kind: "pi" },
            session: {},
          },
        },
      },
    );

    const text = Array.isArray(res) ? res[0]?.text : res?.text;
    expect(text).toBe("ok");
    expect(text).not.toMatch(/Thinking level set/i);
    expect(rpcMock).toHaveBeenCalledOnce();
  });
});
