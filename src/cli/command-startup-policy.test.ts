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
    const paths = [
      "backup create|database|config|config file|config validate|config schema",
      "config set|config patch|config unset|docs|reset|uninstall|agent exec",
      "status|node status|triage|agents bindings|agents add|agents team create|approvals pending",
      "skills|skills list|skills check|skills info|skills search|hooks|hooks list|hooks info|hooks check",
      "memory search|memory status|gateway stop|gateway recover-lock|gateway restart|gateway uninstall",
      "daemon stop|daemon restart|daemon uninstall|gateway diagnostics export",
      "gateway stability|gateway usage-cost|gateway call",
    ].flatMap((group) => group.split("|"));
    for (const commandPath of paths.map((command) => command.split(" "))) {
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

      expect(resolvePolicy({ commandPath: ["status"] }).hideBanner).toBe(true);
      expect(resolvePolicy({ commandPath: ["status"], env: {} }).hideBanner).toBe(false);
    } finally {
      originalEnv.restore();
    }
  });

  it("reserves stdout for the browser native-host protocol", () => {
    expect(resolvePolicy({ commandPath: ["browser", "extension", "native-host"] })).toMatchObject({
      skipConfigGuard: true,
      loadPlugins: false,
      hideBanner: true,
      suppressDoctorStdout: true,
    });
  });

  it("reserves stdout for the node worker protocol", () => {
    expect(resolvePolicy({ commandPath: ["node", "worker"] })).toMatchObject({
      hideBanner: true,
      loadPlugins: false,
      suppressDoctorStdout: true,
      validateConfigOnly: true,
      skipConfigGuard: false,
    });
    expect(resolvePolicy({ commandPath: ["node", "run"] }).validateConfigOnly).toBeUndefined();
  });

  it("isolates cloud worker startup", () => {
    expect(resolvePolicy({ commandPath: ["worker"] })).toMatchObject({
      skipConfigGuard: true,
      hideBanner: true,
      loadPlugins: false,
      suppressDoctorStdout: true,
    });
  });

  it.each([
    ["mcp serve", true],
    ["acp", true],
    ["mcp list", false],
    ["acp client", false],
    ["status", false],
  ] as const)("reserves stdout only for protocol command %s: %s", (command, suppressed) => {
    expect(resolvePolicy({ commandPath: command.split(" ") }).suppressDoctorStdout).toBe(
      suppressed,
    );
  });
});
