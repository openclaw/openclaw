import path from "node:path";
import "./chat-engine.mocks.test-support.js";
import { expect, it, vi } from "vitest";
import type { SetupMemoryImportOutcome } from "../wizard/setup.memory-import.js";
import * as audit from "./audit.js";
import {
  fakeOverviewLoader,
  sharedVerifiedInferenceConfig,
  mocks,
  useTempStateDir,
  createAmbientVerifiedBinding,
  SystemAgentChatEngine,
  type MemoryImportStepParams,
  type OpenClawConfig,
} from "./chat-engine.test-support.js";
import * as hostedSetup from "./hosted-setup.runtime.js";
import { createInferenceConfigFixture } from "./inference-config.test-support.js";

function createEngine(options: ConstructorParameters<typeof SystemAgentChatEngine>[0] = {}) {
  return new SystemAgentChatEngine({
    runAgentTurn: async () => null,
    ...options,
    deps: { loadOverview: fakeOverviewLoader(), ...options.deps },
  });
}

function prepareMemoryConfig(workspace: string): OpenClawConfig {
  const config: OpenClawConfig = {
    ...sharedVerifiedInferenceConfig,
    agents: { ...sharedVerifiedInferenceConfig.agents, defaults: { workspace } },
  };
  mocks.readSetupConfigFileSnapshot.mockResolvedValue({
    exists: true,
    valid: true,
    hash: "memory-base-hash",
    config,
    sourceConfig: config,
  });
  return config;
}

it("refuses memory import before provider discovery when the default workspace is missing", async () => {
  prepareMemoryConfig(path.join(useTempStateDir(), "missing-workspace"));
  const engine = createEngine({ surface: "gateway" });
  const reply = await engine.handle("memory import");
  expect(reply.text).toContain("default agent workspace does not exist");
  expect(reply.text).toContain("Finish onboarding first with `openclaw onboard`");
  expect(mocks.runSetupMemoryImportStep).not.toHaveBeenCalled();
  expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
});

it("rechecks inference authority immediately before a hosted memory copy", async () => {
  const baseConfig = prepareMemoryConfig(useTempStateDir());
  const changedConfig: OpenClawConfig = {
    agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
  };
  const configFixture = await createInferenceConfigFixture(baseConfig);
  const snapshot = configFixture.snapshot;
  const verifiedInference = await createAmbientVerifiedBinding(
    snapshot.runtimeConfig ?? snapshot.config,
    snapshot,
  );
  mocks.readConfigFileSnapshot.mockImplementation(configFixture.read);
  const copyEffect = vi.fn();
  mocks.runSetupMemoryImportStep.mockImplementation(async (params: MemoryImportStepParams) => {
    const confirmed = await params.prompter.confirm({
      message: "Import detected memory?",
      initialValue: true,
    });
    if (!confirmed) {
      return { status: "skipped", providers: [] };
    }
    // Route changes mid-wizard, after the turn gate: only the copy-boundary
    // recheck can catch it.
    await configFixture.write(changedConfig);
    await params.beforeApply?.();
    copyEffect();
    return { status: "completed", providers: [] };
  });
  const engine = createEngine({
    surface: "gateway",
    verifiedInference,
    deps: {
      readConfigFileSnapshot: configFixture.read,
    },
  });

  const confirm = await engine.handle("import memory");
  expect(confirm.text).toContain("Import detected memory?");
  const stopped = await engine.handle("yes");
  expect(stopped.text).toContain("Memory import setup stopped");
  expect(copyEffect).not.toHaveBeenCalled();
});

it.each([
  ["empty", "import memories", "Nothing to import"],
  ["failed", "memory import", "Memory import did not complete"],
  ["partial", "memory import", "Memory import failed partway"],
  ["audit-failure", "import memory", "Imported 1 item from Codex."],
] as const)("reports %s without misrepresenting progress", async (kind, command, expected) => {
  const provider = { providerId: "codex", label: "Codex" };
  const result: SetupMemoryImportOutcome =
    kind === "empty"
      ? { status: "nothing-to-import", providers: [] }
      : {
          status: "completed",
          providers:
            kind === "failed"
              ? ["Codex", "Claude"].map((label) => ({
                  providerId: label.toLowerCase(),
                  label,
                  migrated: 0,
                  skipped: 0,
                  failure: "copy failed",
                }))
              : kind === "partial"
                ? [{ ...provider, failure: "failed", copiesIndeterminate: true }]
                : [{ ...provider, migrated: 1, skipped: 0 }],
        };
  const appendAuditEntry = vi.fn(async () => {
    if (kind === "audit-failure") {
      throw new Error("audit store is read-only");
    }
    return "state/openclaw.sqlite";
  });
  vi.spyOn(audit, "appendSystemAgentAuditEntry").mockImplementation(appendAuditEntry);
  vi.spyOn(hostedSetup, "runHostedMemoryImport").mockResolvedValueOnce(result);
  const reply = await createEngine().handle(command);
  expect(reply.text).toContain(expected);
  if (kind === "empty" || kind === "failed") {
    expect(reply.text).not.toContain("Done");
    expect(appendAuditEntry).not.toHaveBeenCalled();
    if (kind === "empty") {
      expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
    } else {
      expect(reply.text).toContain("Failed providers: Codex, Claude");
    }
  } else if (kind === "partial") {
    expect(reply.text).toContain("Some files may have been copied before the failure");
    expect(reply.text).not.toContain("No files were copied");
    expect(appendAuditEntry).toHaveBeenCalledWith({
      operation: "memory.import",
      summary: "Memory import failed partway via chat: Codex (copy count indeterminate)",
      details: {
        confirmedItems: 0,
        copiesIndeterminate: true,
        providers: [{ providerId: "codex", copiesIndeterminate: true }],
      },
    });
  } else {
    expect(reply.text).not.toContain("audit store is read-only");
  }
});
