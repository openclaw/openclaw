import assert from "node:assert";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logWarn: (msg: string) => mocks.logWarn(msg),
  logDebug: (msg: string) => mocks.logDebug(msg),
}));

const { ignoreCiaoCancellationRejection } = await import("./bonjour-ciao.js");

describe("ignoreCiaoCancellationRejection", () => {
  afterEach(() => {
    mocks.logWarn.mockReset();
    mocks.logDebug.mockReset();
  });

  // ---------- Existing: cancellation rejection ----------

  it("returns true for ciao announcement cancelled", () => {
    const err = new Error("ciao announcement cancelled");
    expect(ignoreCiaoCancellationRejection(err)).toBe(true);
    expect(mocks.logDebug).toHaveBeenCalledTimes(1);
  });

  it("returns true for uppercase CIAO ANNOUNCEMENT CANCELLED", () => {
    const err = new Error("CIAO ANNOUNCEMENT CANCELLED during shutdown");
    expect(ignoreCiaoCancellationRejection(err)).toBe(true);
  });

  // ---------- New: network interface assertion ----------

  it("returns true for ciao MDNSServer IPv4 defined→undefined assertion", () => {
    // Simulate the exact error from MDNSServer.handleUpdatedNetworkInterfaces
    let err: Error;
    try {
      assert.fail("Reached illegal state! IPV4 address change from defined to undefined!");
    } catch (e) {
      err = e as Error;
    }
    // Patch the stack to include MDNSServer (as it would in production)
    err!.stack = `AssertionError [ERR_ASSERTION]: Reached illegal state! IPV4 address change from defined to undefined!
    at MDNSServer.handleUpdatedNetworkInterfaces (/node_modules/@homebridge/ciao/src/MDNSServer.ts:695:18)
    at NetworkManager.emit (node:events:530:35)`;

    expect(ignoreCiaoCancellationRejection(err!)).toBe(true);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("network interface change detected"),
    );
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("watchdog will re-advertise"),
    );
  });

  it("returns true for ciao MDNSServer undefined→defined assertion", () => {
    let err: Error;
    try {
      assert.fail("Reached illegal state! IPv4 address changed from undefined to defined!");
    } catch (e) {
      err = e as Error;
    }
    err!.stack = `AssertionError [ERR_ASSERTION]: ${err!.message}
    at MDNSServer.handleUpdatedNetworkInterfaces (/node_modules/@homebridge/ciao/src/MDNSServer.ts:510:18)`;

    expect(ignoreCiaoCancellationRejection(err!)).toBe(true);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it("returns true for assertion with 'ciao' in stack", () => {
    let err: Error;
    try {
      assert.fail("Reached illegal state! Something else in ciao");
    } catch (e) {
      err = e as Error;
    }
    // Stack includes 'ciao' path but not 'MDNSServer' directly (tests CIAO-only branch)
    err!.stack = `AssertionError [ERR_ASSERTION]: ${err!.message}
    at Object.<anonymous> (/node_modules/@homebridge/ciao/lib/CiaoService.js:515:26)`;

    expect(ignoreCiaoCancellationRejection(err!)).toBe(true);
  });

  // ---------- Should NOT match ----------

  it("returns false for unrelated assertion errors", () => {
    let err: Error;
    try {
      assert.fail("something completely unrelated");
    } catch (e) {
      err = e as Error;
    }
    // Stack has no ciao/MDNSServer references
    err!.stack = `AssertionError [ERR_ASSERTION]: something completely unrelated
    at Object.<anonymous> (/app/src/my-code.ts:42:5)`;

    expect(ignoreCiaoCancellationRejection(err!)).toBe(false);
  });

  it("returns false for non-assertion errors", () => {
    const err = new TypeError("fetch failed");
    expect(ignoreCiaoCancellationRejection(err)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(ignoreCiaoCancellationRejection(null)).toBe(false);
    expect(ignoreCiaoCancellationRejection(undefined)).toBe(false);
  });

  it("returns false for string reasons", () => {
    expect(ignoreCiaoCancellationRejection("some string error")).toBe(false);
  });

  it("returns false for plain objects without assertion properties", () => {
    expect(ignoreCiaoCancellationRejection({ message: "MDNSServer error" })).toBe(false);
  });
});
