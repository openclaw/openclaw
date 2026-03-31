import { describe, expect, it, vi } from "vitest";
import {
  createPluginLoadResult,
  createPluginRecord,
  createTypedHook,
} from "../plugins/status.test-helpers.js";
import * as noteModule from "../terminal/note.js";
import { noteWorkspaceStatus } from "./doctor-workspace-status.js";

const mocks = vi.hoisted(() => ({
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  buildWorkspaceSkillStatus: vi.fn(),
  buildPluginStatusReport: vi.fn(),
  buildPluginCompatibilityWarnings: vi.fn(),
  listFlowRecords: vi.fn(),
  listTasksForFlowId: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (...args: unknown[]) => mocks.resolveAgentWorkspaceDir(...args),
  resolveDefaultAgentId: (...args: unknown[]) => mocks.resolveDefaultAgentId(...args),
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: (...args: unknown[]) => mocks.buildWorkspaceSkillStatus(...args),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginStatusReport: (...args: unknown[]) => mocks.buildPluginStatusReport(...args),
  buildPluginCompatibilityWarnings: (...args: unknown[]) =>
    mocks.buildPluginCompatibilityWarnings(...args),
}));

vi.mock("../tasks/flow-registry.js", () => ({
  listFlowRecords: (...args: unknown[]) => mocks.listFlowRecords(...args),
}));

vi.mock("../tasks/task-registry.js", () => ({
  listTasksForFlowId: (...args: unknown[]) => mocks.listTasksForFlowId(...args),
}));

async function runNoteWorkspaceStatusForTest(
  loadResult: ReturnType<typeof createPluginLoadResult>,
  compatibilityWarnings: string[] = [],
) {
  mocks.resolveDefaultAgentId.mockReturnValue("default");
  mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
  mocks.buildWorkspaceSkillStatus.mockReturnValue({
    skills: [],
  });
  mocks.buildPluginStatusReport.mockReturnValue({
    workspaceDir: "/workspace",
    ...loadResult,
  });
  mocks.buildPluginCompatibilityWarnings.mockReturnValue(compatibilityWarnings);
  mocks.listFlowRecords.mockReturnValue([]);
  mocks.listTasksForFlowId.mockReturnValue([]);

  const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
  noteWorkspaceStatus({});
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
      expect(mocks.buildPluginStatusReport).toHaveBeenCalledWith({
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
      expect(mocks.buildPluginCompatibilityWarnings).toHaveBeenCalledWith({
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

  it("surfaces ClawFlow recovery guidance for suspicious linear flows", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(createPluginLoadResult({ plugins: [] }));
    mocks.listFlowRecords.mockReturnValue([
      {
        flowId: "flow-orphaned",
        shape: "linear",
        ownerSessionKey: "agent:main:main",
        status: "waiting",
        notifyPolicy: "done_only",
        goal: "Process PRs",
        waitingOnTaskId: "task-wait-missing",
        createdAt: 10,
        updatedAt: 20,
      },
      {
        flowId: "flow-blocked",
        shape: "single_task",
        ownerSessionKey: "agent:main:main",
        status: "blocked",
        notifyPolicy: "done_only",
        goal: "Patch file",
        blockedTaskId: "task-missing",
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    mocks.listTasksForFlowId.mockImplementation((flowId: string) => {
      if (flowId === "flow-blocked") {
        return [{ taskId: "task-other" }];
      }
      return [];
    });

    noteWorkspaceStatus({});

    try {
      const recoveryCalls = noteSpy.mock.calls.filter(([, title]) => title === "ClawFlow recovery");
      expect(recoveryCalls).toHaveLength(1);
      const body = String(recoveryCalls[0]?.[0]);
      expect(body).toContain(
        "flow-orphaned: waiting flow points at missing task task-wait-missing",
      );
      expect(body).toContain("flow-blocked: blocked flow points at missing task task-missing");
      expect(body).toContain("openclaw flows show <flow-id>");
      expect(body).toContain("openclaw flows cancel <flow-id>");
    } finally {
      noteSpy.mockRestore();
    }
  });
});
