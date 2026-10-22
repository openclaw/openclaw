import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emptyMetadataSnapshot,
  metadataSnapshot,
} from "../plugins/management-service.test-helpers.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { WizardSession } from "../wizard/session.js";
import {
  ensureCodexRuntimePluginForModelSelection,
  ensureCodexRuntimePluginForSupervision,
  ensureModelSelectionRuntimePlugins,
  repairModelSelectionRuntimePlugins,
} from "./runtime-plugin-install.js";

const mocks = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  repairMissingPluginInstallsForIds: vi.fn(),
  ensureOnboardingPluginInstalled: vi.fn(),
  metadata: vi.fn(),
  writeInstallRecords: vi.fn(),
}));

vi.mock("./doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingPluginInstallsForIds: mocks.repairMissingPluginInstallsForIds,
}));

vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLease: mocks.writeInstallRecords,
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: mocks.metadata,
}));
vi.mock("./onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled: mocks.ensureOnboardingPluginInstalled,
}));
const runtime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });
type SelectionOptions = Parameters<typeof ensureCodexRuntimePluginForModelSelection>[0];
function selectionOptions(options: Partial<SelectionOptions> = {}): SelectionOptions {
  return {
    cfg: {},
    model: "openai/gpt-5.5",
    prompter: {} as never,
    runtime: {} as never,
    ...options,
  };
}
const selectRuntime = (options: Partial<SelectionOptions> = {}) =>
  ensureCodexRuntimePluginForModelSelection(selectionOptions(options));
const selectRuntimes = (options: Partial<SelectionOptions> = {}) =>
  ensureModelSelectionRuntimePlugins(selectionOptions(options));
function installerResult(
  status: "failed" | "installed" | "skipped" | "timed_out",
  cfg: OpenClawConfig = {},
  extra: { error?: string; pluginId?: string } = {},
) {
  return { cfg, installed: status === "installed", pluginId: "codex", status, ...extra };
}
function mockInstall(...args: Parameters<typeof installerResult>) {
  mocks.ensureOnboardingPluginInstalled.mockResolvedValueOnce(installerResult(...args));
}

function providerRuntime(provider: string, id: string, baseUrl: string): OpenClawConfig {
  return { models: { providers: { [provider]: { baseUrl, models: [], agentRuntime: { id } } } } };
}

describe("Codex runtime plugin install repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({ changes: [], warnings: [] });
    mocks.ensureOnboardingPluginInstalled.mockResolvedValue(installerResult("failed"));
  });

  it.each([false, true, new WizardCancelledError()])(
    "requires consent for runtime capabilities: %s",
    async (answer) => {
      await withTestDir({ prefix: "openclaw-runtime-consent-" }, async (artifactDir) => {
        createColdPluginFixture({
          rootDir: artifactDir,
          pluginId: "codex",
          manifest: {
            providers: [],
            channels: [],
            channelConfigs: {},
            providerAuthChoices: [],
            contracts: { tools: ["runtime.write"] },
          },
        });
        const record = { source: "npm", installPath: artifactDir, integrity: "sha512-runtime" };
        mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({ codex: record });
        const metadata = metadataSnapshot({
          id: "codex",
          name: "Codex",
          enabled: false,
          origin: "global",
          installRecord: record,
          contracts: { tools: ["runtime.write"] },
        });
        metadata.byPluginId.get("codex")!.rootDir = artifactDir;
        metadata.index.plugins[0]!.rootDir = artifactDir;
        mocks.metadata.mockReturnValue(metadata);
        const cfg: OpenClawConfig = { plugins: { entries: { codex: { enabled: false } } } };
        const beforePersistentEffect = vi.fn();
        const confirm = vi.fn(async () => {
          expect(beforePersistentEffect).not.toHaveBeenCalled();
          if (answer instanceof Error) {
            throw answer;
          }
          return answer;
        });

        const pending = selectRuntime({
          cfg,
          prompter: { confirm, note: vi.fn(async () => {}) } as never,
          runtime: runtime(),
          beforePersistentEffect,
        });
        if (answer instanceof Error) {
          await expect(pending).rejects.toBe(answer);
          expect(mocks.writeInstallRecords).not.toHaveBeenCalled();
          return;
        }
        const result = await pending;
        expect(cfg.plugins?.entries?.codex?.enabled).toBe(false);
        expect(confirm).toHaveBeenCalledOnce();
        if (answer) {
          expect(result).toMatchObject({
            ok: true,
            cfg: { plugins: { entries: { codex: { enabled: true } } } },
          });
          expect(beforePersistentEffect).toHaveBeenCalledOnce();
          expect(mocks.writeInstallRecords).toHaveBeenCalledWith(
            expect.objectContaining({
              codex: expect.objectContaining({
                acceptedSurface: expect.objectContaining({ tools: ["runtime.write"] }),
                acceptedSurfaceIntegrity: "sha512-runtime",
              }),
            }),
            expect.any(Object),
          );
        } else {
          expect(result).toMatchObject({
            ok: false,
            status: "failed",
            message: expect.stringMatching(/capabilit/i),
          });
          expect(result).not.toHaveProperty("cfg");
          expect(beforePersistentEffect).not.toHaveBeenCalled();
          expect(mocks.writeInstallRecords).not.toHaveBeenCalled();
        }
        expect(mocks.ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
      });
    },
  );

  it("bridges fresh runtime installer progress through a hosted wizard", async () => {
    mocks.ensureOnboardingPluginInstalled.mockImplementationOnce(async ({ cfg, prompter }) => {
      prompter.progress("Installing runtime").stop();
      const accepted = await prompter.confirm({
        message: "Continue installation?",
        initialValue: false,
      });
      return installerResult(accepted ? "installed" : "skipped", cfg);
    });
    const session = new WizardSession(async (prompter) => {
      const result = await selectRuntime({ prompter, runtime: runtime() });
      expect(result.ok).toBe(true);
    });
    try {
      const progress = await session.next();
      expect(progress).toMatchObject({
        done: false,
        step: { type: "progress", message: "Installing runtime" },
      });
      const confirmation = await session.next();
      expect(confirmation.step).toMatchObject({ type: "confirm", initialValue: false });
      await session.answer(confirmation.step!.id, true);
      await expect(session.next()).resolves.toMatchObject({ done: true, status: "done" });
    } finally {
      session.cancel();
      await session.whenSettled();
    }
  });

  it("surfaces non-fatal Copilot repair notices to command callers", async () => {
    const reviewNotice = "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check";
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Repaired missing configured plugin "copilot".'],
      warnings: [],
      notices: [reviewNotice],
    });

    const result = await repairModelSelectionRuntimePlugins({
      cfg: providerRuntime("github-copilot", "copilot", "https://provider.example.test"),
      model: "github-copilot/gpt-5.5",
      env: {},
    });

    expect(mocks.repairMissingPluginInstallsForIds).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ pluginIds: ["copilot"], env: {} }),
    );
    expect(result).toStrictEqual([reviewNotice]);
  });

  it("does not report an existing Codex install as usable when plugins are disabled", async () => {
    const cfg = { plugins: { enabled: false } };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { source: "npm", installPath: process.cwd() },
    });

    const result = await selectRuntime({ cfg });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      message: expect.stringContaining("Codex runtime is required but unavailable"),
    });
    expect("cfg" in result).toBe(false);
  });

  const sensitiveFixture = ["fixture", "credential"].join("-");
  it("formats a sanitized actionable failure for required Codex", async () => {
    mockInstall(
      "failed",
      {},
      {
        error: `Install failed: https://user:${sensitiveFixture}@registry.example.test/pkg?token=${sensitiveFixture}\u001b[2K`,
      },
    );

    const result = await selectRuntime();

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected required runtime failure");
    }
    expect(result.message).toContain("Codex runtime is required but unavailable");
    expect(result.message).toContain("status: failed");
    expect(result.message).toContain("Retry setup");
    expect(result.message).toContain("npm");
    expect(result.message).toContain("registry");
    expect(result.message).toContain("Install failed:");
    expect(result.message).not.toContain(sensitiveFixture);
    expect(result.message).not.toContain("\u001b");
    expect(result).not.toHaveProperty("cfg");
  });

  it("sees an agent-scoped Codex runtime pin behind a custom OpenAI route", async () => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { source: "npm", installPath: process.cwd() },
    });
    const cfg = {
      agents: {
        entries: {
          ops: {
            model: { primary: "openai/gpt-5.5" },
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        },
      },
      models: { providers: { openai: { baseUrl: "https://proxy.example.test/v1", models: [] } } },
    };

    const result = await selectRuntime({ cfg, agentId: "ops" });

    expect(result).toMatchObject({ ok: true, required: true });
  });

  it("stops the aggregate after a required Codex failure with no config result", async () => {
    mockInstall(
      "failed",
      { plugins: { entries: { codex: { enabled: false } } } },
      {
        error: "registry unavailable",
      },
    );

    const result = await selectRuntimes();

    expect(result).toEqual({ ok: false, message: expect.stringContaining("registry unavailable") });
    expect(result).not.toHaveProperty("cfg");
    expect(mocks.ensureOnboardingPluginInstalled).toHaveBeenCalledOnce();
  });

  it("evaluates Copilot after optional Codex and returns the closed success shape", async () => {
    const installedConfig = { plugins: { entries: { copilot: { enabled: true } } } };
    mockInstall("installed", installedConfig, { pluginId: "copilot" });

    const result = await selectRuntimes({
      cfg: providerRuntime("github-copilot", "copilot", "https://api.githubcopilot.com"),
      model: "github-copilot/gpt-5.5",
    });

    expect(result).toEqual({ ok: true, cfg: installedConfig, codexInstalled: false });
    expect(mocks.ensureOnboardingPluginInstalled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entry: expect.objectContaining({ pluginId: "copilot" }) }),
    );
  });

  it("keeps runtime installation prompt-free for silent supervision", async () => {
    const prompter = createWizardPrompter();
    mocks.ensureOnboardingPluginInstalled.mockImplementationOnce(async (params) => {
      expect(await params.onCapabilityConsent({})).toBeUndefined();
      return installerResult("installed", params.cfg);
    });
    const result = await ensureCodexRuntimePluginForSupervision(
      selectionOptions({ prompter, runtime: runtime(), output: "silent" }),
    );
    expect(result).toMatchObject({ ok: true, required: true });
    expect(mocks.ensureOnboardingPluginInstalled).toHaveBeenCalledOnce();
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it.each(["silent", "interactive"] as const)(
    "suppresses installer presentation in %s mode",
    async (output) => {
      const note = vi.fn(async () => {}),
        log = vi.fn(),
        error = vi.fn();
      mocks.ensureOnboardingPluginInstalled.mockImplementationOnce(async (params) => {
        await params.prompter.note("installer failure");
        params.runtime.error("installer failure");
        if (output === "silent") {
          params.prompter.progress("installing").update("downloading");
          params.runtime.log("installer log");
          await expect(params.prompter.confirm({ message: "fallback?" })).rejects.toThrow(
            "Runtime plugin install unexpectedly prompted",
          );
        }
        return installerResult(output === "silent" ? "timed_out" : "failed");
      });
      const select = output === "silent" ? selectRuntimes : selectRuntime;
      await select({ prompter: { note } as never, runtime: { log, error, exit: vi.fn() }, output });
      expect(note).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      if (output === "silent") {
        expect(log).not.toHaveBeenCalled();
      }
    },
  );
});
