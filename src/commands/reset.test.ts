import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCleanupCommandRuntime,
  resetCleanupCommandMocks,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

function loggedMessages(runtime: ReturnType<typeof createCleanupCommandRuntime>) {
  const calls = (runtime.log as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls;
  return calls.map(([message]) => String(message));
}

describe("resetCommand", () => {
  const runtime = createCleanupCommandRuntime();
  let resetCommand: typeof import("./reset.js").resetCommand;

  beforeAll(async () => {
    ({ resetCommand } = await import("./reset.js"));
  });

  beforeEach(() => {
    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
  });

  it("recommends creating a backup before state-destructive reset scopes", async () => {
    await resetCommand(runtime, {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      loggedMessages(runtime).some((message) => message.includes("openclaw backup create")),
    ).toBe(true);
  });

  it("does not recommend backup for config-only reset", async () => {
    await resetCommand(runtime, {
      scope: "config",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      loggedMessages(runtime).some((message) => message.includes("openclaw backup create")),
    ).toBe(false);
  });
});
