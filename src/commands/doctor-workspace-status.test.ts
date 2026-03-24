import { describe, expect, it, vi } from "vitest";
import * as noteModule from "../terminal/note.js";

const resolveAgentWorkspaceDirMock = vi.fn();
const resolveDefaultAgentIdMock = vi.fn();
const buildWorkspaceSkillStatusMock = vi.fn();
const loadOpenClawPluginsMock = vi.fn();

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
  resolveDefaultAgentId: (...args: unknown[]) => resolveDefaultAgentIdMock(...args),
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: (...args: unknown[]) => buildWorkspaceSkillStatusMock(...args),
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

function createPluginLoadResult(params: { plugins: unknown[]; typedHooks?: unknown[] }) {
  return {
    plugins: params.plugins,
    diagnostics: [],
    channels: [],
    channelSetups: [],
    providers: [],
    speechProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    webSearchProviders: [],
    tools: [],
    hooks: [],
    typedHooks: params.typedHooks ?? [],
    httpRoutes: [],
    gatewayHandlers: {},
    cliRegistrars: [],
    services: [],
    commands: [],
    conversationBindingResolvedHandlers: [],
  };
}

async function runNoteWorkspaceStatusForTest(
  loadResult: ReturnType<typeof createPluginLoadResult>,
) {
  resolveDefaultAgentIdMock.mockReturnValue("default");
  resolveAgentWorkspaceDirMock.mockReturnValue("/workspace");
  buildWorkspaceSkillStatusMock.mockReturnValue({
    skills: [],
  });
  loadOpenClawPluginsMock.mockReturnValue(loadResult);

  const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
  const { noteWorkspaceStatus } = await import("./doctor-workspace-status.js");
  noteWorkspaceStatus({});
  return noteSpy;
}

describe("noteWorkspaceStatus", () => {
  it("warns when plugins use legacy compatibility paths", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          {
            id: "legacy-plugin",
            name: "Legacy Plugin",
            source: "/tmp/legacy-plugin/index.ts",
            origin: "workspace",
            enabled: true,
            status: "loaded",
            toolNames: [],
            hookNames: [],
            channelIds: [],
            providerIds: [],
            speechProviderIds: [],
            mediaUnderstandingProviderIds: [],
            imageGenerationProviderIds: [],
            webSearchProviderIds: [],
            gatewayMethods: [],
            cliCommands: [],
            services: [],
            commands: [],
            httpRoutes: 0,
            hookCount: 1,
            configSchema: false,
          },
        ],
        typedHooks: [
          {
            pluginId: "legacy-plugin",
            hookName: "before_agent_start",
            handler: () => undefined,
            source: "/tmp/legacy-plugin/index.ts",
          },
        ],
      }),
    );
    try {
      const compatibilityCalls = noteSpy.mock.calls.filter(
        ([, title]) => title === "Plugin compatibility",
      );
      expect(compatibilityCalls).toHaveLength(1);
      expect(String(compatibilityCalls[0]?.[0])).toContain(
        "legacy-plugin still uses legacy before_agent_start",
      );
      expect(String(compatibilityCalls[0]?.[0])).toContain(
        "legacy-plugin is hook-only. This remains a supported compatibility path",
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("surfaces bundle plugin capabilities in the plugins note", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          {
            id: "claude-bundle",
            name: "Claude Bundle",
            source: "/tmp/claude-bundle",
            origin: "workspace",
            enabled: true,
            status: "loaded",
            format: "bundle",
            bundleFormat: "claude",
            bundleCapabilities: ["skills", "commands", "agents"],
            toolNames: [],
            hookNames: [],
            channelIds: [],
            providerIds: [],
            speechProviderIds: [],
            mediaUnderstandingProviderIds: [],
            imageGenerationProviderIds: [],
            webSearchProviderIds: [],
            gatewayMethods: [],
            cliCommands: [],
            services: [],
            commands: [],
            httpRoutes: 0,
            hookCount: 0,
            configSchema: false,
          },
        ],
      }),
    );
    try {
      const pluginCalls = noteSpy.mock.calls.filter(([, title]) => title === "Plugins");
      expect(pluginCalls).toHaveLength(1);
      const body = String(pluginCalls[0]?.[0]);
      expect(body).toContain("Bundle plugins: 1");
      expect(body).toContain("agents, commands, skills");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("omits plugin compatibility note when no legacy compatibility paths are present", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          {
            id: "modern-plugin",
            name: "Modern Plugin",
            source: "/tmp/modern-plugin/index.ts",
            origin: "workspace",
            enabled: true,
            status: "loaded",
            toolNames: [],
            hookNames: [],
            channelIds: [],
            providerIds: ["modern"],
            speechProviderIds: [],
            mediaUnderstandingProviderIds: [],
            imageGenerationProviderIds: [],
            webSearchProviderIds: [],
            gatewayMethods: [],
            cliCommands: [],
            services: [],
            commands: [],
            httpRoutes: 0,
            hookCount: 0,
            configSchema: false,
          },
        ],
      }),
    );
    try {
      expect(noteSpy.mock.calls.some(([, title]) => title === "Plugin compatibility")).toBe(false);
    } finally {
      noteSpy.mockRestore();
    }
  });
});
