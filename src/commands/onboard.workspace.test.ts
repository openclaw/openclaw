import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setupWizardCommand } from "./onboard.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runSetup = vi.hoisted(() => vi.fn());
const handleReset = vi.hoisted(() => vi.fn());
const targetLock = vi.hoisted(() => vi.fn());

vi.mock("./onboard-interactive.js", () => ({ runInteractiveSetup: runSetup }));
vi.mock("./onboard-guided.js", () => ({ runGuidedOnboarding: runSetup }));
vi.mock("./onboard-non-interactive.js", () => ({ runNonInteractiveSetup: runSetup }));
vi.mock("./onboard-interactive-runner.js", () => ({ hasInteractiveOnboardingTty: () => true }));
vi.mock("./onboard-helpers.js", () => ({ DEFAULT_WORKSPACE: "/tmp/workspace", handleReset }));
vi.mock("../wizard/setup.migration-snapshot.js", () => ({
  withSetupMigrationTargetLock: targetLock,
}));

it.each([{}, { classic: true }, { nonInteractive: true, acceptRisk: true }])(
  "rejects an impossible --workspace before reset or setup with %j",
  async (options) => {
    const root = tempDirs.make("openclaw-onboard-workspace-");
    const blocker = path.join(root, "regular-file");
    fs.writeFileSync(blocker, "keep");
    const runtime = createTestRuntime();
    await setupWizardCommand(
      { ...options, workspace: path.join(blocker, "nested", "workspace"), reset: true, json: true },
      runtime,
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`"${blocker}" is not a directory`),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"phase": "options"'));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(handleReset).not.toHaveBeenCalled();
    expect(targetLock).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
    expect(fs.readFileSync(blocker, "utf8")).toBe("keep");
  },
);
