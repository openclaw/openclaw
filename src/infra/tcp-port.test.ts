// Covers TCP port parsing boundaries.
import { describe, expect, it } from "vitest";
import { parseTcpPort, parseTcpPortFromArgs } from "./tcp-port.js";

describe("parseTcpPort", () => {
  it("accepts valid TCP port values", () => {
    expect(parseTcpPort(1)).toBe(1);
    expect(parseTcpPort("8080")).toBe(8080);
    expect(parseTcpPort(" 65535 ")).toBe(65_535);
  });

  it("rejects invalid TCP port values", () => {
    expect(parseTcpPort(undefined)).toBeNull();
    expect(parseTcpPort(null)).toBeNull();
    expect(parseTcpPort(0)).toBeNull();
    expect(parseTcpPort(-1)).toBeNull();
    expect(parseTcpPort(65_536)).toBeNull();
    expect(parseTcpPort("100000")).toBeNull();
    expect(parseTcpPort("8080ms")).toBeNull();
    expect(parseTcpPort("1.5")).toBeNull();
  });
});

describe("parseTcpPortFromArgs", () => {
  it("returns the last valid separated and equals-form --port values", () => {
    expect(parseTcpPortFromArgs(["gateway", "--port", "18789", "--port", "19001"])).toBe(19001);
    expect(parseTcpPortFromArgs(["gateway", "--port=18789", "--port=19002"])).toBe(19002);
    expect(
      parseTcpPortFromArgs(["gateway", "--port", "18789", "--port=19003", "--port", "19004"]),
    ).toBe(19004);
  });

  it("ignores invalid occurrences and keeps the last valid port", () => {
    expect(parseTcpPortFromArgs(["gateway", "--port", "nope", "--port", "19003"])).toBe(19003);
    expect(parseTcpPortFromArgs(["gateway", "--port", "19001", "--port", "65536"])).toBe(19001);
    expect(parseTcpPortFromArgs(["gateway", "--port=nope", "--port=19005"])).toBe(19005);
  });

  it("returns null when no valid --port is present", () => {
    expect(parseTcpPortFromArgs(undefined)).toBeNull();
    expect(parseTcpPortFromArgs([])).toBeNull();
    expect(parseTcpPortFromArgs(["gateway"])).toBeNull();
    expect(parseTcpPortFromArgs(["gateway", "--port", "nope"])).toBeNull();
  });
});
