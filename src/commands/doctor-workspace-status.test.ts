import { describe, expect, it, vi } from "vitest";
import {
  createPluginLoadResult,
  createPluginRecord,
  createTypedHook,
} from "../plugins/status.test-helpers.js";
import * as noteModule from "../terminal/note.js";

const resolveAgentWorkspaceDirMock = vi.fn();
const resolveDefaultAgentIdMock = vi.fn();
const buildWorkspaceSkillStatusMock = vi.fn();
const buildPluginStatusReportMock = vi.fn();
const buildPluginCompatibilityWarningsMock = vi.fn();

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
  resolveDefaultAgentId: (...args: unknown[]) => resolveDefaultAgentIdMock(...args),
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: (...args: unknown[]) => buildWorkspaceSkillStatusMock(...args),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginStatusReport: (...args: unknown[]) => buildPluginStatusReportMock(...args),
  buildPluginCompatibilityWarnings: (...args: unknown[]) =>
    buildPluginCompatibilityWarningsMock(...args),
}));

async function runNoteWorkspaceStatusForTest(
  loadResult: ReturnType<typeof createPluginLoadResult>,
  compatibilityWarnings: string[] = [],
  options?: Parameters<(typeof import("./doctor-workspace-status.js"))["noteWorkspaceStatus"]>[1],
) {
  resolveDefaultAgentIdMock.mockReturnValue("default");
  resolveAgentWorkspaceDirMock.mockReturnValue("/workspace");
  buildWorkspaceSkillStatusMock.mockReturnValue({
    skills: [],
  });
  buildPluginStatusReportMock.mockReturnValue({
    workspaceDir: "/workspace",
    ...loadResult,
  });
  buildPluginCompatibilityWarningsMock.mockReturnValue(compatibilityWarnings);

  const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
  const { noteWorkspaceStatus } = await import("./doctor-workspace-status.js");
  noteWorkspaceStatus({}, options);
  return noteSpy;
}

describe("noteWorkspaceStatus", () => {
  it("warns when plugins use legacy compatibility paths", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "legacy-plugin",
            name: "Legacy Plugin",
            hookCount: 1,
          }),
        ],
        typedHooks: [
          createTypedHook({ pluginId: "legacy-plugin", hookName: "before_agent_start" }),
        ],
      }),
    );
    try {
      expect(buildPluginStatusReportMock).toHaveBeenCalledWith({
        config: {},
        workspaceDir: "/workspace",
      });
      const compatibilityCalls = noteSpy.mock.calls.filter(
        ([, title]) => title === "Plugin compatibility",
      );
      expect(compatibilityCalls).toHaveLength(0);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("surfaces bundle plugin capabilities in the plugins note", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "claude-bundle",
            name: "Claude Bundle",
            source: "/tmp/claude-bundle",
            format: "bundle",
            bundleFormat: "claude",
            bundleCapabilities: ["skills", "commands", "agents"],
          }),
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
          createPluginRecord({
            id: "modern-plugin",
            name: "Modern Plugin",
            providerIds: ["modern"],
          }),
        ],
      }),
    );
    try {
      expect(noteSpy.mock.calls.some(([, title]) => title === "Plugin compatibility")).toBe(false);
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("passes the shared status report into compatibility warnings", async () => {
    const loadResult = createPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "legacy-plugin",
          name: "Legacy Plugin",
          hookCount: 1,
        }),
      ],
      typedHooks: [createTypedHook({ pluginId: "legacy-plugin", hookName: "before_agent_start" })],
    });
    const noteSpy = await runNoteWorkspaceStatusForTest(loadResult, [
      "legacy-plugin still uses legacy before_agent_start",
    ]);
    try {
      expect(buildPluginCompatibilityWarningsMock).toHaveBeenCalledWith({
        config: {},
        workspaceDir: "/workspace",
        report: {
          workspaceDir: "/workspace",
          ...loadResult,
        },
      });
      const compatibilityCalls = noteSpy.mock.calls.filter(
        ([, title]) => title === "Plugin compatibility",
      );
      expect(compatibilityCalls).toHaveLength(1);
      expect(String(compatibilityCalls[0]?.[0])).toContain(
        "legacy-plugin still uses legacy before_agent_start",
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("skips plugin status loading when includePluginStatus is false", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "modern-plugin",
            name: "Modern Plugin",
            providerIds: ["modern"],
          }),
        ],
      }),
      [],
      { includePluginStatus: false },
    );
    try {
      expect(buildPluginStatusReportMock).not.toHaveBeenCalled();
      expect(buildPluginCompatibilityWarningsMock).not.toHaveBeenCalled();
      expect(noteSpy.mock.calls.some(([, title]) => title === "Plugins")).toBe(false);
      expect(noteSpy.mock.calls.some(([, title]) => title === "Plugin compatibility")).toBe(false);
    } finally {
      noteSpy.mockRestore();
    }
  });
});
