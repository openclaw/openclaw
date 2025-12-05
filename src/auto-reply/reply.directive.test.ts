import { afterEach, describe, expect, it, vi } from "vitest";
import * as tauRpc from "../process/tau-rpc.js";
import {
  extractThinkDirective,
  extractVerboseDirective,
  getReplyFromConfig,
} from "./reply.js";

describe("directive parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores verbose directive inside URL", () => {
    const body = "https://x.com/verioussmith/status/1997066835133669687";
    const res = extractVerboseDirective(body);
    expect(res.hasDirective).toBe(false);
    expect(res.cleaned).toBe(body);
  });

  it("ignores typoed /verioussmith", () => {
    const body = "/verioussmith";
    const res = extractVerboseDirective(body);
    expect(res.hasDirective).toBe(false);
    expect(res.cleaned).toBe(body.trim());
  });

  it("ignores think directive inside URL", () => {
    const body = "see https://example.com/path/thinkstuff";
    const res = extractThinkDirective(body);
    expect(res.hasDirective).toBe(false);
  });

  it("matches verbose with leading space", () => {
    const res = extractVerboseDirective(" please /verbose on now");
    expect(res.hasDirective).toBe(true);
    expect(res.verboseLevel).toBe("on");
  });

  it("matches think at start of line", () => {
    const res = extractThinkDirective("/think:high run slow");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBe("high");
  });

  it("applies inline think and still runs agent content", async () => {
    const rpcMock = vi.spyOn(tauRpc, "runPiRpc").mockResolvedValue({
      stdout:
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    const res = await getReplyFromConfig(
      {
        Body: "please sync /think:high now",
        From: "+1004",
        To: "+2000",
      },
      {},
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
    expect(text).toBe("done");
    expect(rpcMock).toHaveBeenCalledOnce();
  });

  it("acks verbose directive immediately with system marker", async () => {
    const rpcMock = vi.spyOn(tauRpc, "runPiRpc").mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    const res = await getReplyFromConfig(
      { Body: "/verbose on", From: "+1222", To: "+1222" },
      {},
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
    expect(text).toMatch(/^⚙️ Verbose logging enabled\./);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
