import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { SetupAppRecommendationsResult } from "../system-agent/setup-app-recommendations.js";
import type { WizardPrompter } from "./prompts.js";
import { setupAppRecommendations } from "./setup.app-recommendations.js";

function createPrompter(selected: string[] = []): WizardPrompter {
  return {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    plain: vi.fn(async () => undefined),
    select: vi.fn(),
    multiselect: vi.fn(async () => selected),
    text: vi.fn(),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function recommendationResult(): Extract<SetupAppRecommendationsResult, { status: "ok" }> {
  const apps = [{ label: "Chat", bundleId: "com.example.chat" }];
  const matches = [
    {
      appLabel: "Chat",
      candidateId: "chat-plugin",
      tier: "recommended" as const,
      reason: "Connects conversations",
      candidate: {
        id: "chat-plugin",
        displayName: "Chat plugin",
        summary: "Chat",
        source: "official-channel" as const,
      },
    },
    {
      appLabel: "Chat",
      candidateId: "chat-skill",
      tier: "optional" as const,
      reason: "Adds useful actions",
      candidate: {
        id: "chat-skill",
        displayName: "Chat skill",
        summary: "Chat skill",
        source: "clawhub-skill" as const,
      },
    },
  ];
  return { status: "ok", apps, groups: [{ app: apps[0]!, candidates: [] }], matches };
}

describe("setupAppRecommendations", () => {
  it.each([
    [{ wizard: { appRecommendations: false } }, "darwin" as const],
    [{}, "linux" as const],
  ])("skips when gated", async (config, platform) => {
    const recommend = vi.fn(async () => recommendationResult());
    await setupAppRecommendations({
      config,
      prompter: createPrompter(),
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform,
      deps: { recommend },
    });
    expect(recommend).not.toHaveBeenCalled();
  });

  it("preselects recommended matches and installs selected plugin and skill", async () => {
    const config: OpenClawConfig = {};
    const prompter = createPrompter(["recommendation:0", "recommendation:1"]);
    const ensurePlugin = vi.fn(async () => ({
      cfg: { ...config, plugins: { entries: { "chat-plugin": { enabled: true } } } },
      installed: true,
      pluginId: "chat-plugin",
      status: "installed" as const,
    }));
    const installSkill = vi.fn(async () => ({
      ok: true as const,
      slug: "chat-skill",
      version: "1.0.0",
      targetDir: "/tmp/workspace/skills/chat-skill",
    }));

    const result = await setupAppRecommendations({
      config,
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        recommend: async () => recommendationResult(),
        ensurePlugin,
        installSkill,
        resolveOfficialEntry: (pluginId) => ({
          pluginId,
          label: "Chat plugin",
          install: { npmSpec: "@openclaw/chat-plugin" },
        }),
      },
    });

    expect(prompter.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ initialValues: ["recommendation:0"] }),
    );
    expect(ensurePlugin).toHaveBeenCalledOnce();
    expect(installSkill).toHaveBeenCalledOnce();
    expect(result.plugins?.entries?.["chat-plugin"]?.enabled).toBe(true);
  });

  it("installs nothing when the explicit skip entry is selected", async () => {
    const ensurePlugin = vi.fn();
    const installSkill = vi.fn();
    const config: OpenClawConfig = {};

    await expect(
      setupAppRecommendations({
        config,
        prompter: createPrompter(["__skip__", "recommendation:0"]),
        runtime,
        workspaceDir: "/tmp/workspace",
        modelRouteVerified: true,
        platform: "darwin",
        deps: {
          recommend: async () => recommendationResult(),
          ensurePlugin,
          installSkill,
        },
      }),
    ).resolves.toBe(config);
    expect(ensurePlugin).not.toHaveBeenCalled();
    expect(installSkill).not.toHaveBeenCalled();
  });
});
