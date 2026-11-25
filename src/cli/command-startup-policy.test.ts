import { afterEach, expect, it, vi } from "vitest";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";

function resolvePolicy(
  command: string,
  params: Partial<Parameters<typeof resolveCliStartupPolicy>[0]> = {},
) {
  return resolveCliStartupPolicy({
    commandPath: command.split(" "),
    jsonOutputMode: false,
    ...params,
  });
}
afterEach(() => vi.unstubAllEnvs());

it("leaves reset config and state preparation to onboarding", () => {
  expect(resolvePolicy("onboard").skipConfigGuard).toBe(false);
  for (const command of ["onboard", "setup"]) {
    for (const params of [
      { argv: ["node", "openclaw", command, "--reset"] },
      { options: { reset: true } },
    ]) {
      expect(resolvePolicy(command, params)).toMatchObject({
        skipConfigGuard: true,
        validateConfigOnly: true,
        loadPlugins: false,
      });
    }
  }
});

it("defers gateway installs with a runtime expectation", () => {
  expect(resolvePolicy("gateway install").skipConfigGuard).toBe(false);
  expect(
    resolvePolicy("gateway install", {
      options: { expectedRuntimePin: "{}" },
      jsonOutputMode: true,
    }).skipConfigGuard,
  ).toBe(true);
});

it("maps the static skip policy to config admission", () => {
  expect(resolvePolicy("config file").skipConfigGuard).toBe(true);
});
it("uses process env banner suppression when startup env is omitted", () => {
  vi.stubEnv("OPENCLAW_HIDE_BANNER", "1");
  expect(resolvePolicy("status").hideBanner).toBe(true);
  expect(resolvePolicy("status", { env: {} }).hideBanner).toBe(false);
});

it("reserves stdout for the node worker protocol", () => {
  expect(resolvePolicy("node worker")).toMatchObject({
    hideBanner: true,
    loadPlugins: false,
    suppressDoctorStdout: true,
    validateConfigOnly: true,
    skipConfigGuard: false,
  });
  expect(resolvePolicy("node run").validateConfigOnly).toBeUndefined();
});

it.each([
  ["mcp serve", true],
  ["acp", true],
  ["mcp list", false],
  ["acp client", false],
  ["status", false],
] as const)("reserves stdout only for protocol command %s: %s", (command, suppressed) => {
  expect(resolvePolicy(command).suppressDoctorStdout).toBe(suppressed);
});
