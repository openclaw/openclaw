import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  repairMissingPluginInstallsForIds: vi.fn(),
}));

type MissingPluginInstallRepairCall = {
  pluginIds: string[];
  env?: NodeJS.ProcessEnv;
};

function readOnlyMissingPluginInstallRepairCall(): MissingPluginInstallRepairCall {
  expect(mocks.repairMissingPluginInstallsForIds).toHaveBeenCalledOnce();
  const calls = mocks.repairMissingPluginInstallsForIds.mock.calls as unknown as Array<
    [MissingPluginInstallRepairCall]
  >;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected missing plugin install repair call");
  }
  return call;
}

vi.mock("./doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingPluginInstallsForIds: mocks.repairMissingPluginInstallsForIds,
}));

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
}));

describe("Codex runtime plugin install repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: [],
      warnings: [],
    });
  });

  it("surfaces non-fatal ClawHub repair notices to warning-only callers", async () => {
    const reviewNotice = "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check";
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Repaired missing configured plugin "codex".'],
      warnings: [],
      notices: [reviewNotice],
    });

    const { repairCodexRuntimePluginInstallForModelSelection } =
      await import("./codex-runtime-plugin-install.js");
    const result = await repairCodexRuntimePluginInstallForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      env: {},
    });

    const repairCall = readOnlyMissingPluginInstallRepairCall();
    expect(repairCall.pluginIds).toStrictEqual(["codex"]);
    expect(repairCall.env).toStrictEqual({});
    expect(result).toStrictEqual({
      required: true,
      changes: ['Repaired missing configured plugin "codex".'],
      warnings: [reviewNotice],
    });
  });

  it.each([
    ["plugins disabled", { plugins: { enabled: false } }],
    ["denylisted", { plugins: { deny: ["codex"] } }],
    ["not allowlisted", { plugins: { allow: ["other"] } }],
  ])("does not report an existing Codex install as usable when %s", async (_label, cfg) => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { source: "npm", installPath: process.cwd() },
    });
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg,
      model: "openai/gpt-5.5",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toMatchObject({
      cfg,
      required: true,
      installed: false,
      status: "failed",
    });
    expect(result.reason).toBeTruthy();
  });

  it("enables an allowed existing Codex install", async () => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { source: "npm", installPath: process.cwd() },
    });
    const cfg = {
      plugins: {
        allow: ["codex"],
        entries: { codex: { enabled: false } },
      },
    };
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg,
      model: "openai/gpt-5.5",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toMatchObject({
      required: true,
      installed: true,
      status: "installed",
      cfg: { plugins: { entries: { codex: { enabled: true } } } },
    });
  });
});
