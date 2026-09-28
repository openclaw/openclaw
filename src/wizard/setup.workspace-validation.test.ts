import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";
import { runSetupWizard } from "./setup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const writeConfig = vi.hoisted(() => vi.fn());
vi.mock("./setup.shared.js", () => ({
  readSetupConfigFileSnapshot: async () => ({ exists: false, valid: true, config: {} }),
  requireRiskAcknowledgement: async ({ config }: { config: OpenClawConfig }) => config,
  requestTelemetryConsent: async ({ config }: { config: OpenClawConfig }) => config,
  resolveQuickstartGatewayDefaults: () => ({ port: 19791 }),
  writeWizardConfigFile: writeConfig,
}));
vi.mock("./setup.migration-import.js", () => ({
  detectSetupMigrationSources: async () => ({ detections: [], providerDescriptors: [] }),
  listSetupMigrationOptions: async () => [],
}));
vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/workspace",
  printWizardHeader: async () => {},
  probeGatewayReachable: async () => ({ ok: false }),
}));

it("rejects non-directory workspaces in the real prompt while accepting directories and new paths", async () => {
  const root = tempDirs.make("openclaw-workspace-prompt-");
  const blocker = path.join(root, "regular-file");
  const alias = path.join(root, "directory-link");
  fs.writeFileSync(blocker, "keep");
  fs.symlinkSync(root, alias, "dir");
  const cancelled = new WizardCancelledError();
  const text = vi.fn<WizardPrompter["text"]>(async ({ validate }) => {
    expect(validate).toBeTypeOf("function");
    for (const candidate of [blocker, path.join(blocker, "nested", "workspace")]) {
      expect(validate?.(candidate)).toContain(`"${blocker}" is not a directory`);
    }
    for (const candidate of [root, alias, path.join(root, "new", "workspace"), ""]) {
      expect(validate?.(candidate)).toBeUndefined();
    }
    throw cancelled;
  });
  await expect(
    runSetupWizard(
      { flow: "advanced", mode: "local", acceptRisk: true },
      createTestRuntime(),
      createWizardPrompter({ text }),
    ),
  ).rejects.toBe(cancelled);
  expect(text).toHaveBeenCalledOnce();
  expect(writeConfig).not.toHaveBeenCalled();
  expect(fs.readFileSync(blocker, "utf8")).toBe("keep");
});
