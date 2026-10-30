await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));
import "./launchd-fs.mocks.test-support.js";
import { expect, it, vi } from "vitest";
import { createGatewayRestartDeadline } from "../cli/daemon-cli/restart-health-deadline.js";
import * as nativeExec from "./exec-file.js";
import {
  createLaunchdEnvWithGatewayPort,
  createTestLaunchAgentPlist,
  launchAgentControlFixture,
} from "./launchd-install.test-support.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import { resolveLaunchAgentPlistPath, restartLaunchAgent } from "./launchd.js";

it("rejects a hung bootout at the caller's shared deadline without starting recovery", async () => {
  const env = createLaunchdEnvWithGatewayPort("18789");
  state.files.set(
    resolveLaunchAgentPlistPath(env),
    createTestLaunchAgentPlist({
      label: "ai.openclaw.gateway",
      programArguments: ["node", "gateway.js"],
    }),
  );
  const exec = vi.mocked(nativeExec.execFileUtf8).getMockImplementation()!;
  let entered!: () => void;
  const bootout = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(nativeExec, "execFileUtf8").mockImplementation((command, args, options) => {
    if (args[0] !== "bootout") {
      return exec(command, args, options);
    }
    entered();
    // Simulate the process runner's native timeout for a command that never exits.
    return new Promise((resolve) => {
      if (options?.timeout === undefined) {
        return;
      }
      setTimeout(
        () =>
          resolve({
            code: 1,
            stdout: "",
            stderr: "timed out",
            termination: "timeout",
          }),
        options?.timeout,
      );
    });
  });
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const deadline = createGatewayRestartDeadline({ timeoutMs: 60_000 });
  const result = restartLaunchAgent(launchAgentControlFixture(env, { deadline }));
  let completed = false;
  void result.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  try {
    await Promise.race([
      bootout,
      result.then(() => {
        throw new Error("Restart completed without attempting bootout");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(completed).toBe(true);
    await expect(result).rejects.toThrow("timed out");
    expect(state.launchctlCalls.map((call) => call[0])).not.toContain("bootstrap");
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});
