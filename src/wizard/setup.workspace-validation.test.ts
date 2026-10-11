import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";
import { runSetupWizard } from "./setup.js";
import { validateSetupWorkspacePath } from "./setup.workspace.js";

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

it("validates workspace prompt paths", async () => {
  const root = tempDirs.make("openclaw-workspace-prompt-");
  const blocker = path.join(root, "regular-file");
  const alias = path.join(root, "directory-link");
  const dangling = path.join(root, "dangling-link");
  const selfLoop = path.join(root, "self-loop");
  const cycle = path.join(root, "cycle-a");
  const cycleTarget = path.join(root, "cycle-b");
  fs.writeFileSync(blocker, "keep");
  fs.symlinkSync(root, alias, "dir");
  fs.symlinkSync(path.join(root, "missing-target"), dangling, "dir");
  fs.symlinkSync(selfLoop, selfLoop, "dir");
  fs.symlinkSync(cycleTarget, cycle, "dir");
  fs.symlinkSync(cycle, cycleTarget, "dir");
  const cancelled = new WizardCancelledError();
  const text = vi.fn<WizardPrompter["text"]>(async ({ validate }) => {
    expect(validate).toBeTypeOf("function");
    expect(validate?.(blocker)).toContain(`"${blocker}" is not a directory`);
    expect(validate?.(dangling)).toContain(
      `"${dangling}" is a symbolic link that does not resolve to an existing directory`,
    );
    for (const loop of [selfLoop, cycle]) {
      expect
        .soft(validate?.(loop))
        .toContain(`"${loop}" cannot be resolved because of a symlink loop`);
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

it("reports filesystem inspection errors at the symlink target", () => {
  const root = tempDirs.make("openclaw-workspace-errors-");
  const candidate = path.join(root, "workspace");
  fs.symlinkSync(root, candidate, "dir");
  const probe = vi.spyOn(fs, "statSync");
  try {
    for (const [code, message] of [
      ["ELOOP", "symlink loop"],
      ["EACCES", "Cannot inspect"],
    ]) {
      probe.mockImplementation((input) => {
        throw Object.assign(new Error("filesystem inspection failed"), {
          code: input === candidate ? code : "ENOENT",
        });
      });
      const result = validateSetupWorkspacePath(candidate);
      expect.soft(result).toContain(`"${candidate}"`);
      expect.soft(result).toContain(message);
      expect.soft(result).not.toContain("does not resolve to an existing directory");
    }
  } finally {
    probe.mockRestore();
  }
});
