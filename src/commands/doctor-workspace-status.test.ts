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

describe("noteWorkspaceStatus", () => {
  it("warns when plugins use legacy compatibility paths", async () => {
    resolveDefaultAgentIdMock.mockReturnValue("default");
    resolveAgentWorkspaceDirMock.mockReturnValue("/workspace");
    buildWorkspaceSkillStatusMock.mockReturnValue({
      skills: [],
    });
    loadOpenClawPluginsMock.mockReturnValue({
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
      typedHooks: [
        {
          pluginId: "legacy-plugin",
          hookName: "before_agent_start",
          handler: () => undefined,
          source: "/tmp/legacy-plugin/index.ts",
        },
      ],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
      conversationBindingResolvedHandlers: [],
    });

    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      const { noteWorkspaceStatus } = await import("./doctor-workspace-status.js");
      noteWorkspaceStatus({});

      const compatibilityCalls = noteSpy.mock.calls.filter(
        ([, title]) => title === "Plugin compatibility",
      );
      expect(compatibilityCalls).toHaveLength(1);
      expect(String(compatibilityCalls[0]?.[0])).toContain(
        "legacy-plugin still relies on legacy before_agent_start",
      );
      expect(String(compatibilityCalls[0]?.[0])).toContain(
        "legacy-plugin is hook-only; this remains supported for compatibility",
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("omits plugin compatibility note when no legacy compatibility paths are present", async () => {
    resolveDefaultAgentIdMock.mockReturnValue("default");
    resolveAgentWorkspaceDirMock.mockReturnValue("/workspace");
    buildWorkspaceSkillStatusMock.mockReturnValue({
      skills: [],
    });
    loadOpenClawPluginsMock.mockReturnValue({
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
      typedHooks: [],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
      conversationBindingResolvedHandlers: [],
    });

    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      const { noteWorkspaceStatus } = await import("./doctor-workspace-status.js");
      noteWorkspaceStatus({});

      expect(noteSpy.mock.calls.some(([, title]) => title === "Plugin compatibility")).toBe(false);
    } finally {
      noteSpy.mockRestore();
    }
  });
});
