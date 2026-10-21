import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import * as currentService from "./launchd-current-service.js";
import * as native from "./launchd-exec.js";
import { restartLaunchAgent, startLaunchAgent } from "./launchd-lifecycle.js";
import * as runtime from "./launchd-runtime.js";
import * as ownership from "./launchd-system.js";

const success = { code: 0, termination: "exit" as const, stdout: "", stderr: "" };
const missing = { ...success, code: 1, stderr: "Could not find service" };
const policy = (disabled = false) => ({
  ...success,
  stdout: `disabled services = {\n"ai.openclaw.gateway" => ${disabled ? "disabled" : "enabled"}\n}`,
});
const job = (target: string | undefined, loaded: boolean) =>
  loaded ? { ...success, stdout: `${target} = {\n\tstate = waiting\n}` } : missing;
const controlArgs = (preserveAutoStart = true) => ({
  env: { HOME: "/fixture/user" },
  stdout: new PassThrough(),
  preserveDefinition: true,
  preserveAutoStart,
});
function mockLaunchctl(
  handlers: Record<string, (args: string[]) => native.LaunchctlResult>,
  before: (command: string) => void = () => {},
) {
  vi.spyOn(native, "execLaunchctl").mockImplementation(async (args) => {
    const command = args[0];
    if (!command) {
      throw new Error("Missing native command");
    }
    before(command);
    const handler = Object.hasOwn(handlers, command) ? handlers[command] : undefined;
    if (!handler) {
      throw new Error("Unexpected native command: " + command);
    }
    return handler(args);
  });
}

beforeEach(() => {
  vi.spyOn(ownership, "assertNoSystemLaunchDaemonOwnership").mockResolvedValue();
  vi.spyOn(currentService, "isCurrentProcessInsideLaunchdService").mockResolvedValue(false);
  vi.spyOn(runtime, "resolveLaunchAgentGatewayContext").mockImplementation(async (env) => ({
    env,
    port: null,
    probeHosts: [],
  }));
});
afterEach(() => vi.restoreAllMocks());

it.each(
  ["loaded", "not-loaded", "recovery", "bootstrap-failure"].flatMap((scenario) =>
    [true, false].map((preserveAutoStart) => ({ scenario, preserveAutoStart })),
  ),
)(
  "retains launchd policy: $scenario preserve=$preserveAutoStart",
  async ({ scenario, preserveAutoStart }) => {
    const commands: string[] = [];
    let loaded = scenario === "loaded";
    let kicks = 0;
    let bootstraps = 0;
    mockLaunchctl(
      {
        "print-disabled": () => policy(),
        enable: () => success,
        print: (args) => job(args[1], loaded),
        bootstrap: () => {
          if (scenario === "bootstrap-failure" && bootstraps++ === 0) {
            return { ...success, code: 5, stderr: "fixture bootstrap failure" };
          }
          loaded = true;
          return success;
        },
        kickstart: () => {
          if (scenario === "recovery" && kicks++ === 0) {
            return { ...success, code: 5, stderr: "fixture kickstart failure" };
          }
          return loaded ? success : missing;
        },
      },
      (command) => {
        commands.push(command);
      },
    );
    const result = restartLaunchAgent(controlArgs(preserveAutoStart));
    if (scenario === "bootstrap-failure") {
      await expect(result).rejects.toThrow("fixture bootstrap failure");
    } else {
      await expect(result).resolves.toEqual({ outcome: "completed" });
    }
    expect(loaded).toBe(true);
    expect(commands.includes("enable")).toBe(!preserveAutoStart);
    expect(commands).not.toContain("disable");
    expect(commands).not.toContain("bootout");
    if (scenario !== "loaded") {
      expect(commands).toContain("bootstrap");
    }
  },
);

const phases = [
  "activation",
  "nested-activation",
  "restoration",
  "disabled-bootstrap",
  "disabled-restoration",
] as const;
it.each(
  (["start", "restart"] as const).flatMap((action) => phases.map((phase) => ({ action, phase }))),
)(
  "preserves uncertain cleanup during $action $phase without further native commands",
  async ({ action, phase }) => {
    const cleanup = new CommandProcessCleanupError();
    const failure =
      phase === "nested-activation" ? new AggregateError([cleanup], "activation failed") : cleanup;
    const commandsAfterUncertainCleanup: string[] = [];
    let uncertainCleanup = false;
    let inspections = 0;
    mockLaunchctl(
      {
        kickstart: () => ({ ...success, code: 5, stderr: "fixture activation failure" }),
        print: (args) => job(args[1], ++inspections === 1 && phase !== "disabled-bootstrap"),
        "print-disabled": () => policy(phase.startsWith("disabled-")),
        enable: () => success,
        disable: () => success,
      },
      (command) => {
        if (uncertainCleanup) {
          commandsAfterUncertainCleanup.push(command);
        }
        if (
          (command === "kickstart" && ["activation", "nested-activation"].includes(phase)) ||
          command === "bootstrap"
        ) {
          uncertainCleanup = true;
          throw failure;
        }
      },
    );
    const activate = action === "start" ? startLaunchAgent : restartLaunchAgent;
    await expect(activate({ ...controlArgs(), assertCurrent: () => {} })).rejects.toBe(failure);
    expect(commandsAfterUncertainCleanup).toEqual([]);
  },
);
