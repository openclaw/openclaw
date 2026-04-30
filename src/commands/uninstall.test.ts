import { beforeEach, describe, expect, it } from "vitest";
import {
  createCleanupCommandRuntime,
  removeStateAndLinkedPaths,
  resetCleanupCommandMocks,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

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

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("openclaw backup create"));
  });

  it("does not recommend backup for service-only uninstall", async () => {
    await uninstallCommand(runtime, {
      service: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("openclaw backup create"));
  });

  it("preserves workspace dirs during state-only uninstall", async () => {
    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeStateAndLinkedPaths).toHaveBeenCalledWith(
      expect.any(Object),
      runtime,
      expect.objectContaining({
        dryRun: true,
        preservePaths: ["/tmp/.openclaw/workspace"],
      }),
    );
  });

  it("does not preserve workspace dirs when workspace removal is selected", async () => {
    await uninstallCommand(runtime, {
      state: true,
      workspace: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeStateAndLinkedPaths).toHaveBeenCalledWith(
      expect.any(Object),
      runtime,
      expect.objectContaining({
        dryRun: true,
        preservePaths: [],
      }),
    );
  });
});
