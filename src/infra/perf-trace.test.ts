import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createPerfTrace, isPerfTraceEnabled } from "./perf-trace.js";

describe("isPerfTraceEnabled", () => {
  it("matches configured diagnostic flags", () => {
    const cfg = {
      diagnostics: { flags: ["slack.perf"] },
    } as OpenClawConfig;

    expect(isPerfTraceEnabled({ flags: ["slack.perf.send"], cfg })).toBe(false);
    expect(isPerfTraceEnabled({ flags: ["slack.perf", "slack.perf.send"], cfg })).toBe(true);
  });
});

describe("createPerfTrace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays silent when perf flags are disabled", () => {
    const log = vi.fn();
    const trace = createPerfTrace({
      label: "slack.send",
      flags: ["slack.perf", "slack.perf.send"],
      cfg: {} as OpenClawConfig,
      log,
    });

    trace.mark("start");
    trace.end();

    expect(trace.enabled).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("emits structured metrics when enabled", () => {
    const log = vi.fn();
    const trace = createPerfTrace({
      label: "slack.send",
      flags: ["slack.perf", "slack.perf.send"],
      cfg: {
        diagnostics: { flags: ["slack.perf"] },
      } as OpenClawConfig,
      log,
      meta: {
        accountId: "default",
      },
    });

    trace.mark("channel.resolved", { channelId: "D123" });
    trace.end({ messageId: "123.456" });

    expect(trace.enabled).toBe(true);
    expect(log).toHaveBeenCalledTimes(2);

    const first = String(log.mock.calls[0]?.[0] ?? "");
    expect(first.startsWith("[perf:slack.send] ")).toBe(true);
    const firstPayload = JSON.parse(first.replace(/^\[perf:[^\]]+\] /, "")) as {
      phase: string;
      status: string;
      wallMs: number;
      cpuMs: number;
      rssMb: number;
      meta?: Record<string, unknown>;
    };
    expect(firstPayload.phase).toBe("channel.resolved");
    expect(firstPayload.status).toBe("mark");
    expect(typeof firstPayload.wallMs).toBe("number");
    expect(typeof firstPayload.cpuMs).toBe("number");
    expect(typeof firstPayload.rssMb).toBe("number");
    expect(firstPayload.meta).toMatchObject({
      accountId: "default",
      channelId: "D123",
    });

    const second = String(log.mock.calls[1]?.[0] ?? "");
    const secondPayload = JSON.parse(second.replace(/^\[perf:[^\]]+\] /, "")) as {
      phase: string;
      status: string;
      meta?: Record<string, unknown>;
    };
    expect(secondPayload.phase).toBe("end");
    expect(secondPayload.status).toBe("end");
    expect(secondPayload.meta).toMatchObject({
      accountId: "default",
      messageId: "123.456",
    });
  });
});
