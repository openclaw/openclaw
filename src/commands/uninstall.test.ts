import { beforeEach, describe, expect, it } from "vitest";
import {
  createCleanupCommandRuntime,
  resetCleanupCommandMocks,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

function loggedMessages(runtime: ReturnType<typeof createCleanupCommandRuntime>) {
  const calls = (runtime.log as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls;
  return calls.map(([message]) => String(message));
}

const { uninstallCommand } = await import("./uninstall.js");

describe("uninstallCommand", () => {
  const runtime = createCleanupCommandRuntime();

  beforeEach(() => {
    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
  });

  it("recommends creating a backup before removing state or workspaces", async () => {
    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      loggedMessages(runtime).some((message) => message.includes("openclaw backup create")),
    ).toBe(true);
  });

  it("does not recommend backup for service-only uninstall", async () => {
    await uninstallCommand(runtime, {
      service: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      loggedMessages(runtime).some((message) => message.includes("openclaw backup create")),
    ).toBe(false);
  });
});
