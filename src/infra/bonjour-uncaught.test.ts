import { describe, expect, it } from "vitest";
import { isCiaoMdnsServerClosedError } from "./bonjour-uncaught.js";

describe("isCiaoMdnsServerClosedError", () => {
  it("matches by code", () => {
    const err = Object.assign(new Error("x"), { code: "ERR_SERVER_CLOSED" });
    expect(isCiaoMdnsServerClosedError(err)).toBe(true);
  });

  it("matches by message", () => {
    const err = new Error("Cannot send packets on a closed mdns server!");
    expect(isCiaoMdnsServerClosedError(err)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isCiaoMdnsServerClosedError(new Error("nope"))).toBe(false);
  });
});
