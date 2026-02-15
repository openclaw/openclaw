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
    expect(shouldSkipRespawnForArgv(["node", "openclaw", "--help"])).toBe(true);
    expect(shouldSkipRespawnForArgv(["node", "openclaw", "-V"])).toBe(true);
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
  it("parses bytes with units", () => {
    expect(parseByteSize("10kb")).toBe(10 * 1024);
    expect(parseByteSize("1mb")).toBe(1024 * 1024);
    expect(parseByteSize("2gb")).toBe(2 * 1024 * 1024 * 1024);
  });

  it("parses shorthand units", () => {
    expect(parseByteSize("5k")).toBe(5 * 1024);
    expect(parseByteSize("1m")).toBe(1024 * 1024);
  });

  it("uses default unit when omitted", () => {
    expect(parseByteSize("123")).toBe(123);
  });

  it("rejects invalid values", () => {
    expect(() => parseByteSize("")).toThrow();
    expect(() => parseByteSize("nope")).toThrow();
    expect(() => parseByteSize("-5kb")).toThrow();
  });
});

describe("parseDurationMs", () => {
  it("parses bare ms", () => {
    expect(parseDurationMs("10000")).toBe(10_000);
  });

  it("parses seconds suffix", () => {
    expect(parseDurationMs("10s")).toBe(10_000);
  });

  it("parses minutes suffix", () => {
    expect(parseDurationMs("1m")).toBe(60_000);
  });

  it("parses hours suffix", () => {
    expect(parseDurationMs("2h")).toBe(7_200_000);
  });

  it("parses days suffix", () => {
    expect(parseDurationMs("2d")).toBe(172_800_000);
  });

  it("supports decimals", () => {
    expect(parseDurationMs("0.5s")).toBe(500);
  });
});
