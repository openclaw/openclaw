import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as currentService from "./launchd-current-service.js";
import * as native from "./launchd-exec.js";
import { restartLaunchAgent } from "./launchd-lifecycle.js";
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
  ["loaded", "not-loaded", "recovery"].flatMap((scenario) =>
    [true, false].map((preserveAutoStart) => ({ scenario, preserveAutoStart })),
  ),
)(
  "retains launchd policy: $scenario preserve=$preserveAutoStart",
  async ({ scenario, preserveAutoStart }) => {
    const commands: string[] = [];
    let loaded = scenario === "loaded";
    let firstKick = true;
    const success = { code: 0, termination: "exit" as const, stdout: "", stderr: "" };
    vi.spyOn(native, "execLaunchctl").mockImplementation(async (args) => {
      const command = args[0];
      if (!command) {
        throw new Error("Missing native command");
      }
      commands.push(command);
      if (command === "print-disabled") {
        return { ...success, stdout: 'disabled services = { "ai.openclaw.gateway" => enabled }' };
      }
      if (command === "enable") {
        return success;
      }
      if (command === "print") {
        return loaded ? success : { ...success, code: 1, stderr: "Could not find service" };
      }
      if (command === "bootstrap") {
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
    if (scenario === "recovery") {
      await expect(result).rejects.toThrow("fixture kickstart failure");
    } else {
      await expect(result).resolves.toEqual({ outcome: "completed" });
    }
    expect(commands.includes("enable")).toBe(!preserveAutoStart);
    expect(commands).not.toContain("disable");
    expect(commands).not.toContain("bootout");
    if (scenario !== "loaded") {
      expect(commands).toContain("bootstrap");
    }
  },
);
