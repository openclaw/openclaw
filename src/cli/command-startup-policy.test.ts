// Command startup policy tests cover which CLI commands require startup side effects.
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";

function resolvePolicy(params: {
  argv?: string[];
  commandPath: string[];
  jsonOutputMode?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  return resolveCliStartupPolicy({
    jsonOutputMode: false,
    ...params,
  });
}

describe("command-startup-policy", () => {
  it("leaves reset config and state preparation to onboarding", () => {
    expect(resolvePolicy({ commandPath: ["onboard"] }).skipConfigGuard).toBe(false);
    for (const command of ["onboard", "setup"]) {
      for (const params of [
        { argv: ["node", "openclaw", command, "--reset"] },
        { options: { reset: true } },
      ]) {
        expect(
          resolveCliStartupPolicy({ ...params, commandPath: [command], jsonOutputMode: false }),
        ).toMatchObject({
          skipConfigGuard: true,
          validateConfigOnly: true,
          loadPlugins: false,
        });
      }
    }
  });

  it.each(["gateway"])("defers only %s installs with a runtime expectation", (parent) => {
    const commandPath = [parent, "install"];
    expect(resolvePolicy({ commandPath }).skipConfigGuard).toBe(false);
    expect(
      resolveCliStartupPolicy({
        commandPath,
        options: { expectedRuntimePin: "{}" },
        jsonOutputMode: true,
      }).skipConfigGuard,
    ).toBe(true);
  });

  it("resolves config guard policy for Commander and invocation-aware commands", () => {
    for (const commandPath of [
      ["backup", "create"],
      ["database"],
      ["config"],
      ["config", "file"],
      ["config", "validate"],
      ["config", "schema"],
      ["config", "set"],
      ["config", "patch"],
      ["config", "unset"],
      ["docs"],
      ["reset"],
      ["uninstall"],
      ["agent", "exec"],
      ["status"],
      ["node", "status"],
      ["triage"],
      ["agents", "bindings"],
      ["agents", "add"],
      ["agents", "team", "create"],
      ["approvals", "pending"],
      ["skills"],
      ["skills", "list"],
      ["skills", "check"],
      ["skills", "info"],
      ["skills", "search"],
      ["hooks"],
      ["hooks", "list"],
      ["hooks", "info"],
      ["hooks", "check"],
      ["memory", "search"],
      ["memory", "status"],
      ["gateway", "stop"],
      ["gateway", "restart"],
      ["gateway", "uninstall"],
      ["daemon", "stop"],
      ["daemon", "restart"],
      ["daemon", "uninstall"],
      ["gateway", "diagnostics", "export"],
      ["gateway", "stability"],
      ["gateway", "usage-cost"],
      ["gateway", "call"],
    ]) {
      expect(resolvePolicy({ commandPath }).skipConfigGuard, commandPath.join(" ")).toBe(true);
    }
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
      }).skipConfigGuard,
    ).toBe(true);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent", "--local"],
        commandPath: ["agent"],
      }).skipConfigGuard,
    ).toBe(false);
    for (const flag of ["--index", "--fix"]) {
      expect(
        resolvePolicy({
          argv: ["node", "openclaw", "memory", "status", flag],
          commandPath: ["memory", "status"],
        }).skipConfigGuard,
      ).toBe(false);
    }
  });
  it("uses process env banner suppression when startup env is omitted", () => {
    const originalEnv = captureEnv(["OPENCLAW_HIDE_BANNER"]);
    try {
      process.env.OPENCLAW_HIDE_BANNER = "1";

      expect(
        resolveCliStartupPolicy({
          commandPath: ["status"],
          jsonOutputMode: false,
        }).hideBanner,
      ).toBe(true);
      expect(
        resolveCliStartupPolicy({
          commandPath: ["status"],
          jsonOutputMode: false,
          env: {},
        }).hideBanner,
      ).toBe(false);
    } finally {
      originalEnv.restore();
    }
  });
  it("suppresses startup stdout for the mcp serve protocol", () => {
    expect(resolvePolicy({ commandPath: ["mcp", "serve"] }).suppressDoctorStdout).toBe(true);
  });

  it("reserves stdout for the browser native-host protocol", () => {
    const policy = resolvePolicy({ commandPath: ["browser", "extension", "native-host"] });

    expect(policy.skipConfigGuard).toBe(true);
    expect(policy.loadPlugins).toBe(false);
    expect(policy.hideBanner).toBe(true);
    expect(policy.suppressDoctorStdout).toBe(true);
  });

  it("reserves stdout for the node worker protocol", () => {
    const policy = resolvePolicy({ commandPath: ["node", "worker"] });

    expect(policy.hideBanner).toBe(true);
    expect(policy.loadPlugins).toBe(false);
    expect(policy.suppressDoctorStdout).toBe(true);
    expect(policy.validateConfigOnly).toBe(true);
    expect(policy.skipConfigGuard).toBe(false);
    expect(resolvePolicy({ commandPath: ["node", "run"] }).validateConfigOnly).toBeUndefined();
  });

  it("isolates cloud worker startup", () => {
    const policy = resolvePolicy({ commandPath: ["worker"] });

    expect(policy.skipConfigGuard).toBe(true);
    expect(policy.hideBanner).toBe(true);
    expect(policy.loadPlugins).toBe(false);
    expect(policy.suppressDoctorStdout).toBe(true);
  });

  it("suppresses startup stdout for the bare acp protocol", () => {
    expect(resolvePolicy({ commandPath: ["acp"] }).suppressDoctorStdout).toBe(true);
  });

  it("keeps startup stdout for non-protocol commands", () => {
    expect(resolvePolicy({ commandPath: ["mcp", "list"] }).suppressDoctorStdout).toBe(false);
    expect(resolvePolicy({ commandPath: ["acp", "client"] }).suppressDoctorStdout).toBe(false);
    expect(resolvePolicy({ commandPath: ["status"] }).suppressDoctorStdout).toBe(false);
  });
});
