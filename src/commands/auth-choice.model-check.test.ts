import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  resolveAgentModelPrimary: vi.fn(() => undefined),
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
  listProfilesForProvider: vi.fn(() => []),
  resolveCliBackendConfig: vi.fn(() => ({ id: "claude-cli", config: { command: "claude" } })),
  resolveEnvApiKey: vi.fn(() => null),
  getCustomProviderApiKey: vi.fn(() => undefined),
  loadModelCatalog: vi.fn(async () => []),
  isCliProvider: vi.fn(() => true),
  resolveConfiguredModelRef: vi.fn(() => ({ provider: "claude-cli", model: "opus-4.6" })),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentModelPrimary: mocks.resolveAgentModelPrimary,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  listProfilesForProvider: mocks.listProfilesForProvider,
}));

vi.mock("../agents/cli-backends.js", () => ({
  resolveCliBackendConfig: mocks.resolveCliBackendConfig,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey: mocks.resolveEnvApiKey,
  getCustomProviderApiKey: mocks.getCustomProviderApiKey,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", () => ({
  isCliProvider: mocks.isCliProvider,
  resolveConfiguredModelRef: mocks.resolveConfiguredModelRef,
}));

import { warnIfModelConfigLooksOff } from "./auth-choice.model-check.js";

describe("warnIfModelConfigLooksOff for CLI providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCliBackendConfig.mockReturnValue({
      id: "claude-cli",
      config: { command: "claude" },
    });
    mocks.isCliProvider.mockReturnValue(true);
    mocks.resolveConfiguredModelRef.mockReturnValue({ provider: "claude-cli", model: "opus-4.6" });
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: "/usr/bin/claude\n" });
  });

  it("skips API auth/catalog warnings for CLI providers", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});

    await warnIfModelConfigLooksOff(
      {
        agents: { defaults: { model: { primary: "claude-cli/opus-4.6" } } },
      },
      { note } as never,
    );

    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("warns when CLI backend command is not resolvable", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: "" });

    await warnIfModelConfigLooksOff(
      {
        agents: { defaults: { model: { primary: "claude-cli/opus-4.6" } } },
      },
      { note } as never,
    );

    expect(note).toHaveBeenCalledTimes(1);
    expect(String(note.mock.calls[0]?.[0])).toContain("CLI backend command not found");
  });
});
