import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let codexProfiles = 0;
  return {
    codexProfilesRef: {
      get: () => codexProfiles,
      set: (value: number) => {
        codexProfiles = value;
      },
    },
    readConfigFileSnapshot: vi.fn().mockResolvedValue({ valid: true, config: {} }),
    resolveDefaultAgentId: vi.fn().mockReturnValue("main"),
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/openclaw-agent"),
    resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-workspace"),
    resolveDefaultAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-workspace"),
    resolvePluginProviders: vi.fn(),
    createClackPrompter: vi.fn().mockReturnValue({}),
    applyAuthChoice: vi.fn(async () => {
      codexProfiles = 1;
      return { config: {} };
    }),
    loadAuthProfileStore: vi.fn().mockReturnValue({}),
    listProfilesForProvider: vi.fn(() => (codexProfiles > 0 ? ["openai-codex:default"] : [])),
    updateConfig: vi.fn(async () => undefined),
    logConfigUpdated: vi.fn(),
  };
});

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  };
});

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveDefaultAgentId: mocks.resolveDefaultAgentId,
    resolveAgentDir: mocks.resolveAgentDir,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  };
});

vi.mock("../../agents/workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/workspace.js")>();
  return {
    ...actual,
    resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
  };
});

vi.mock("../../plugins/providers.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../auth-choice.apply.js", () => ({
  applyAuthChoice: mocks.applyAuthChoice,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    loadAuthProfileStore: mocks.loadAuthProfileStore,
    listProfilesForProvider: mocks.listProfilesForProvider,
  };
});

vi.mock("./shared.js", () => ({
  updateConfig: mocks.updateConfig,
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

import { modelsAuthLoginCommand } from "./auth.js";

describe("modelsAuthLoginCommand", () => {
  it("supports built-in openai-codex login path without plugin providers", async () => {
    mocks.codexProfilesRef.set(0);
    mocks.resolvePluginProviders.mockReturnValue([]);

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    const originalTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      await modelsAuthLoginCommand(
        { provider: "openai-codex", setDefault: false },
        runtime as never,
      );
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalTTY,
      });
    }

    expect(mocks.applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({ authChoice: "openai-codex" }),
    );
    expect(mocks.resolvePluginProviders).not.toHaveBeenCalled();
    expect(mocks.logConfigUpdated).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: openai-codex:default (openai-codex/oauth)",
    );
  });
});
