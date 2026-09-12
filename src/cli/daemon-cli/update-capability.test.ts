import { afterEach, describe, expect, it, vi } from "vitest";
import { tryRunGatewayServiceUpdateCapabilityProbe } from "./update-capability.js";

afterEach(() => vi.restoreAllMocks());

describe("early service capability routing", () => {
  it.each([
    ["gateway", "install", "--update-executor", "check", "--json"],
    ["gateway", "restart", "--json", "--update-executor=check"],
    ["daemon", "stop", "--update-executor", "check"],
  ])("answers the machine probe %j", (...args) => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(tryRunGatewayServiceUpdateCapabilityProbe(["node", "openclaw", ...args])).toBe(true);
    expect(output).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        updateExecutor: "root-spawner-v1",
        targetRootBinding: true,
        retainedOwnerBinding: true,
      }),
    );
  });

  it.each([
    ["gateway", "install"],
    ["gateway", "install", "--update-executor", "run"],
    ["gateway", "install", "--update-executor", "--json", "check"],
    ["gateway", "install", "--update-executor", "check", "--update-executor", "run"],
    ["gateway", "install", "--token", "--update-executor", "check"],
    ["gateway", "install", "--", "--update-executor", "check"],
    ["gateway", "install", "--update-executor", "check", "--unknown"],
    ["gateway", "status", "--update-executor", "check"],
    ["plugin", "install", "--update-executor", "check"],
  ])("leaves non-probes and validation to Commander: %j", (...args) => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(tryRunGatewayServiceUpdateCapabilityProbe(["node", "openclaw", ...args])).toBe(false);
    expect(output).not.toHaveBeenCalled();
  });
});
