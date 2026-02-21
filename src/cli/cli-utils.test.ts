import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { parseCanvasSnapshotPayload } from "./nodes-canvas.js";
import { parseByteSize } from "./parse-bytes.js";
import { parseDurationMs } from "./parse-duration.js";
import { shouldSkipRespawnForArgv } from "./respawn-policy.js";
import { waitForever } from "./wait.js";

const { registerDnsCli } = await import("./dns-cli.js");

describe("waitForever", () => {
  it("creates an unref'ed interval and returns a pending promise", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const promise = waitForever();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000_000);
    expect(promise).toBeInstanceOf(Promise);
    setIntervalSpy.mockRestore();
  });
});

describe("shouldSkipRespawnForArgv", () => {
  it("skips respawn for help/version calls", () => {
    const cases = [
      ["node", "openclaw", "--help"],
      ["node", "openclaw", "-V"],
    ] as const;
    for (const argv of cases) {
      expect(shouldSkipRespawnForArgv([...argv]), argv.join(" ")).toBe(true);
    }
  });

  it("keeps respawn path for normal commands", () => {
    expect(shouldSkipRespawnForArgv(["node", "openclaw", "status"])).toBe(false);
  });
});

describe("nodes canvas helpers", () => {
  it("parses canvas.snapshot payload", () => {
    expect(parseCanvasSnapshotPayload({ format: "png", base64: "aGk=" })).toEqual({
      format: "png",
      base64: "aGk=",
    });
  });

  it("rejects invalid canvas.snapshot payload", () => {
    expect(() => parseCanvasSnapshotPayload({ format: "png" })).toThrow(
      /invalid canvas\.snapshot payload/i,
    );
  });
});

describe("dns cli", () => {
  it("prints setup info (no apply)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const program = new Command();
      registerDnsCli(program);
      await program.parseAsync(["dns", "setup", "--domain", "openclaw.internal"], { from: "user" });
      const output = log.mock.calls.map((call) => call.join(" ")).join("\\n");
      expect(output).toContain("DNS setup");
      expect(output).toContain("openclaw.internal");
    } finally {
      log.mockRestore();
    }
  });
});

describe("parseByteSize", () => {
  it("parses byte-size units and shorthand values", () => {
    const cases = [
      ["parses 10kb", "10kb", 10 * 1024],
      ["parses 1mb", "1mb", 1024 * 1024],
      ["parses 2gb", "2gb", 2 * 1024 * 1024 * 1024],
      ["parses shorthand 5k", "5k", 5 * 1024],
      ["parses shorthand 1m", "1m", 1024 * 1024],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(parseByteSize(input), name).toBe(expected);
    }
  });

  it("uses default unit when omitted", () => {
    expect(parseByteSize("123")).toBe(123);
  });

  it("rejects invalid values", () => {
    const cases = ["", "nope", "-5kb"] as const;
    for (const input of cases) {
      expect(() => parseByteSize(input), input || "<empty>").toThrow();
    }
  });
});

describe("parseDurationMs", () => {
  it("parses duration strings", () => {
    const cases = [
      ["parses bare ms", "10000", 10_000],
      ["parses seconds suffix", "10s", 10_000],
      ["parses minutes suffix", "1m", 60_000],
      ["parses hours suffix", "2h", 7_200_000],
      ["parses days suffix", "2d", 172_800_000],
      ["supports decimals", "0.5s", 500],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(parseDurationMs(input), name).toBe(expected);
    }
  });
});
