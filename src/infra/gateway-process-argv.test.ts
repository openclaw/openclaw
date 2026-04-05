import { describe, expect, it } from "vitest";
import { isGatewayArgv, parseProcCmdline, parseWindowsCmdline } from "./gateway-process-argv.js";

describe("parseProcCmdline", () => {
  it("splits null-delimited argv and trims empty entries", () => {
    expect(parseProcCmdline(" node \0 gateway \0\0 --port \0 18790 \0")).toEqual([
      "node",
      "gateway",
      "--port",
      "18790",
    ]);
  });

  it("keeps non-delimited single arguments and drops whitespace-only entries", () => {
    expect(parseProcCmdline(" gateway ")).toEqual(["gateway"]);
    expect(parseProcCmdline(" \0\t\0 ")).toEqual([]);
  });
});

describe("parseWindowsCmdline", () => {
  it("splits unquoted tokens by whitespace", () => {
    expect(parseWindowsCmdline("node.exe gateway run")).toEqual(["node.exe", "gateway", "run"]);
  });

  it("handles double-quoted paths with spaces", () => {
    expect(
      parseWindowsCmdline('"C:\\Program Files\\node.exe" "C:\\my app\\dist\\index.js" gateway run'),
    ).toEqual(["C:\\Program Files\\node.exe", "C:\\my app\\dist\\index.js", "gateway", "run"]);
  });

  it("returns empty array for empty input", () => {
    expect(parseWindowsCmdline("")).toEqual([]);
    expect(parseWindowsCmdline("   ")).toEqual([]);
  });

  it("collapses consecutive spaces outside quotes", () => {
    expect(parseWindowsCmdline("node.exe   gateway   run")).toEqual(["node.exe", "gateway", "run"]);
  });
});

describe("isGatewayArgv", () => {
  it("requires a gateway token", () => {
    expect(isGatewayArgv(["node", "dist/index.js", "--port", "18790"])).toBe(false);
  });

  it("matches known entrypoints across slash and case variants", () => {
    expect(isGatewayArgv(["NODE", "C:\\Mullusi\\DIST\\ENTRY.JS", "gateway"])).toBe(true);
    expect(isGatewayArgv(["bun", "/srv/mullusi/scripts/run-node.mjs", "gateway"])).toBe(true);
    expect(isGatewayArgv(["node", "/srv/mullusi/mullusi.mjs", "gateway"])).toBe(true);
    expect(isGatewayArgv(["tsx", "/srv/mullusi/src/entry.ts", "gateway"])).toBe(true);
    expect(isGatewayArgv(["tsx", "/srv/mullusi/src/index.ts", "gateway"])).toBe(true);
  });

  it("matches the mullusi executable but gates the gateway binary behind the opt-in flag", () => {
    expect(isGatewayArgv(["C:\\bin\\mullusi.cmd", "gateway"])).toBe(true);
    expect(isGatewayArgv(["/usr/local/bin/mullusi-gateway", "gateway"])).toBe(false);
    expect(
      isGatewayArgv(["/usr/local/bin/mullusi-gateway", "gateway"], {
        allowGatewayBinary: true,
      }),
    ).toBe(true);
    expect(
      isGatewayArgv(["C:\\bin\\mullusi-gateway.EXE", "gateway"], {
        allowGatewayBinary: true,
      }),
    ).toBe(true);
  });

  it("rejects unknown gateway argv even when the token is present", () => {
    expect(isGatewayArgv(["node", "/srv/mullusi/custom.js", "gateway"])).toBe(false);
    expect(isGatewayArgv(["python", "gateway", "script.py"])).toBe(false);
  });
});
