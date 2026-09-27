import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import * as currentService from "./launchd-current-service.js";
import * as native from "./launchd-exec.js";
import { restartLaunchAgent, startLaunchAgent } from "./launchd-lifecycle.js";
import * as runtime from "./launchd-runtime.js";
import * as ownership from "./launchd-system.js";

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
    let firstKick = true;
    let firstBootstrap = true;
    const success = { code: 0, termination: "exit" as const, stdout: "", stderr: "" };
    vi.spyOn(native, "execLaunchctl").mockImplementation(async (args) => {
      const command = args[0];
      if (!command) {
        throw new Error("Missing native command");
      }
      commands.push(command);
      if (command === "print-disabled") {
        return { ...success, stdout: 'disabled services = {\n"ai.openclaw.gateway" => enabled\n}' };
      }
      if (command === "enable") {
        return success;
      }
      if (command === "print") {
        return loaded ? success : { ...success, code: 1, stderr: "Could not find service" };
      }
      if (command === "bootstrap") {
        if (firstBootstrap && scenario === "bootstrap-failure") {
          firstBootstrap = false;
          return { ...success, code: 5, stderr: "fixture bootstrap failure" };
        }
        loaded = true;
        return success;
      }
      if (command === "kickstart") {
        if (firstKick && scenario === "recovery") {
          firstKick = false;
          return { ...success, code: 5, stderr: "fixture kickstart failure" };
        }
        return loaded ? success : { ...success, code: 1, stderr: "Could not find service" };
      }
      throw new Error("Unexpected native command: " + command);
    });
    const result = restartLaunchAgent({
      env: { HOME: "/fixture/user" },
      stdout: new PassThrough(),
      preserveDefinition: true,
      preserveAutoStart,
    });
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

it.each(
  (["start", "restart"] as const).flatMap((action) =>
    (
      [
        "activation",
        "nested-activation",
        "restoration",
        "disabled-bootstrap",
        "disabled-restoration",
      ] as const
    ).map((phase) => ({
      action,
      phase,
    })),
  ),
)(
  "preserves uncertain cleanup during $action $phase without further native commands",
  async ({ action, phase }) => {
    const cleanup = new CommandProcessCleanupError();
    const failure =
      phase === "nested-activation" ? new AggregateError([cleanup], "activation failed") : cleanup;
    const commandsAfterUncertainCleanup: string[] = [];
    let uncertainCleanup = false;
    let inspections = 0;
    const success = { code: 0, termination: "exit" as const, stdout: "", stderr: "" };
    vi.spyOn(native, "execLaunchctl").mockImplementation(async (args) => {
      const command = args[0];
      if (!command) {
        throw new Error("Missing native command");
      }
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
      if (command === "kickstart") {
        return { ...success, code: 5, stderr: "fixture activation failure" };
      }
      if (command === "print") {
        inspections += 1;
        return inspections === 1 && phase !== "disabled-bootstrap"
          ? success
          : { ...success, code: 1, stderr: "Could not find service" };
      }
      if (command === "print-disabled") {
        const policy = phase.startsWith("disabled-") ? "disabled" : "enabled";
        return {
          ...success,
          stdout: `disabled services = {\n"ai.openclaw.gateway" => ${policy}\n}`,
        };
      }
      if (command === "enable" || command === "disable") {
        return success;
      }
      throw new Error("Unexpected native command: " + command);
    });
    const activate = action === "start" ? startLaunchAgent : restartLaunchAgent;
    await expect(
      activate({
        env: { HOME: "/fixture/user" },
        stdout: new PassThrough(),
        preserveDefinition: true,
        preserveAutoStart: true,
        assertCurrent: () => {},
      }),
    ).rejects.toBe(failure);
    expect(commandsAfterUncertainCleanup).toEqual([]);
  },
);
