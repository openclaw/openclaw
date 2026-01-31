import { describe, expect, it } from "vitest";

import { parseSshTarget } from "./ssh-tunnel.js";

describe("parseSshTarget", () => {
  it("parses user@host:port targets", () => {
    expect(parseSshTarget("me@example.com:2222")).toEqual({
      user: "me",
      host: "example.com",
      port: 2222,
    });
  });

  it("parses host-only targets with default port", () => {
    expect(parseSshTarget("example.com")).toEqual({
      user: undefined,
      host: "example.com",
      port: 22,
    });
  });

  it("rejects hostnames that start with '-'", () => {
    expect(parseSshTarget("-V")).toBeNull();
    expect(parseSshTarget("me@-badhost")).toBeNull();
    expect(parseSshTarget("-oProxyCommand=echo")).toBeNull();
  });
});
