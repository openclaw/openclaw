import { expect, it } from "vitest";
import { isConfigMachineOutput, isConfigSetJsonParseOnly } from "./config-output-mode.js";
import { isCronMachineOutput } from "./cron-cli/output-mode.js";
import { isDoctorMachineOutput } from "./doctor-output-mode.js";
import { isGatewayMachineOutput } from "./gateway-cli/output-mode.js";
import { isProxyMachineOutput } from "./proxy-output-mode.js";
import { isSkillsMachineOutput } from "./skills-output-mode.js";
import { isSystemMachineOutput } from "./system-output-mode.js";

const argv = (...args: string[]) => ["node", "openclaw", ...args];

it("detects system presence", () => {
  expect(isSystemMachineOutput(argv("system", "presence"))).toBe(true);
});

it("detects non-TTY doctor lint without changing terminal output", () => {
  const lint = argv("doctor", "--lint");
  expect(isDoctorMachineOutput({ argv: lint, stdoutIsTTY: false })).toBe(true);
  expect(isDoctorMachineOutput({ argv: lint, stdoutIsTTY: true })).toBe(false);
});

it("reserves doctor JSON output with or without explicit lint mode", () => {
  for (const args of [argv("doctor", "--json"), argv("doctor", "--lint", "--json")]) {
    expect(isDoctorMachineOutput({ argv: args, stdoutIsTTY: true })).toBe(true);
  }
});

it.each([
  [isProxyMachineOutput, "proxy --log-level debug sessions"],
  [isSkillsMachineOutput, "skills --log-level debug verify x"],
  [isGatewayMachineOutput, "gateway --log-level debug restart-handoff capabilities"],
  [isGatewayMachineOutput, "gateway --log-level=debug restart-handoff consume"],
] as const)("accepts supported root options: %s %s", (resolve, args) => {
  expect(resolve(argv(...args.split(" ")))).toBe(true);
});

it("reserves raw cron scratch output", () => {
  expect(isCronMachineOutput(argv("cron", "scratch", "job"))).toBe(true);
  expect(isCronMachineOutput(argv("cron", "scratch", "job", "--set", "note"))).toBe(true);
  expect(isCronMachineOutput(argv("cron", "scratch", "job", "--unset"))).toBe(true);
});

it("treats config set --json as parse-only except for JSON dry-run reports", () => {
  const set = argv("config", "set", "gateway.port");
  expect(isConfigMachineOutput(set)).toBe(false);
  expect(isConfigSetJsonParseOnly([...set, "18789", "--json"])).toBe(true);
  expect(isConfigSetJsonParseOnly([...set, "18789", "--dry-run", "--json"])).toBe(false);
});
