import { describe, expect, it } from "vitest";
import { buildGatewayWatchArgs } from "../../scripts/gateway-watch.mjs";

describe("gateway-watch PowerShell smoke", () => {
  it("uses native Windows-safe gateway run command without --force", () => {
    const args = buildGatewayWatchArgs({ platform: "win32", args: [] });
    expect(args).toEqual([
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      "18789",
      "--allow-unconfigured",
    ]);
    expect(args.includes("--force")).toBe(false);
  });
});
