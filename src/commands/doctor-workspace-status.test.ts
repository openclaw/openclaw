// Doctor workspace status tests cover workspace inspection and status output.
import { describe, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import {
  createPluginLoadResult,
  createPluginRecord,
  createTypedHook,
} from "../plugins/status.test-helpers.js";
import { noteWorkspaceStatus } from "./doctor-workspace-status.js";

const mocks = vi.hoisted(() => ({
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  buildWorkspaceSkillStatus: vi.fn(),
  buildPluginRegistrySnapshotReport: vi.fn(),
  buildPluginCompatibilityWarnings: vi.fn(),
  listTaskFlowRecords: vi.fn<() => unknown[]>(() => []),
  listTasksForFlowId: vi.fn<(flowId: string) => unknown[]>((_flowId: string) => []),
  loadInstalledPluginIndexInstallRecords: vi.fn<() => Promise<Record<string, unknown>>>(() =>
    Promise.resolve({}),
  ),
  VERSION: "2026.6.1",
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (...args: unknown[]) => mocks.resolveAgentWorkspaceDir(...args),
  resolveDefaultAgentId: (...args: unknown[]) => mocks.resolveDefaultAgentId(...args),
}));

vi.mock("../skills/discovery/status.js", () => ({
  buildWorkspaceSkillStatus: (...args: unknown[]) => mocks.buildWorkspaceSkillStatus(...args),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginRegistrySnapshotReport: (...args: unknown[]) =>
    mocks.buildPluginRegistrySnapshotReport(...args),
  buildPluginCompatibilityWarnings: (...args: unknown[]) =>
    mocks.buildPluginCompatibilityWarnings(...args),
}));

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: (...args: unknown[]) =>
    mocks.loadInstalledPluginIndexInstallRecords(...args),
}));

vi.mock("../version.js", () => ({
  VERSION: mocks.VERSION,
}));

vi.mock("../tasks/task-flow-runtime-internal.js", () => ({
  listTaskFlowRecords: () => mocks.listTaskFlowRecords(),
}));

vi.mock("../tasks/runtime-internal.js", () => ({
  listTasksForFlowId: (flowId: string) => mocks.listTasksForFlowId(flowId),
}));

async function runNoteWorkspaceStatusForTest(
  loadResult: ReturnType<typeof createPluginLoadResult>,
  compatibilityWarnings: string[] = [],
  opts?: {
    flows?: unknown[];
    tasksByFlowId?: (flowId: string) => unknown[];
    env?: Record<string, string>;
  },
) {
  mocks.resolveDefaultAgentId.mockReturnValue("default");
  mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
  mocks.buildWorkspaceSkillStatus.mockReturnValue({
    skills: [],
  });
  mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
    workspaceDir: "/workspace",
    ...loadResult,
  });
  mocks.buildPluginCompatibilityWarnings.mockReturnValue(compatibilityWarnings);
  mocks.listTaskFlowRecords.mockReturnValue(opts?.flows ?? []);
  mocks.listTasksForFlowId.mockImplementation((flowId: string) =>
    opts?.tasksByFlowId ? opts.tasksByFlowId(flowId) : [],
  );

  const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
  await noteWorkspaceStatus({}, opts?.env ? { env: opts.env as NodeJS.ProcessEnv } : undefined);
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
      expect(mocks.buildPluginRegistrySnapshotReport).toHaveBeenCalledWith({
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
      const [[body]] = pluginCalls;
      expect(body).toContain("Bundle plugins: 1");
      expect(body).toContain("agents, commands, skills");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("includes imported plugin counts in the plugins note", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "imported-plugin",
            imported: true,
          }),
          createPluginRecord({
            id: "cold-plugin",
            imported: false,
          }),
        ],
      }),
    );
    try {
      const pluginCalls = noteSpy.mock.calls.filter(([, title]) => title === "Plugins");
      expect(pluginCalls).toHaveLength(1);
      const [[body]] = pluginCalls;
      expect(body).toContain("Imported: 1");
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
      expect(noteSpy.mock.calls.map(([, title]) => title)).not.toContain("Plugin compatibility");
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
      expect(mocks.buildPluginRegistrySnapshotReport).toHaveBeenCalledWith({
        config: {},
        workspaceDir: "/workspace",
      });
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
      const [[body]] = compatibilityCalls;
      expect(body).toContain("legacy-plugin still uses legacy before_agent_start");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("adds TaskFlow recovery hints for broken blocked flows", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(createPluginLoadResult(), [], {
      flows: [
        {
          flowId: "flow-123",
          syncMode: "managed",
          ownerKey: "agent:main:main",
          revision: 0,
          status: "blocked",
          notifyPolicy: "done_only",
          goal: "Investigate PR batch",
          blockedTaskId: "task-missing",
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      tasksByFlowId: () => [],
    });
    try {
      const recoveryCalls = noteSpy.mock.calls.filter(([, title]) => title === "TaskFlow recovery");
      expect(recoveryCalls).toHaveLength(1);
      const [[body]] = recoveryCalls;
      expect(body).toContain("flow-123");
      expect(body).toContain("openclaw tasks flow show <flow-id>");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("reports plugin version drift when an official plugin version mismatches the gateway", async () => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: {
        source: "npm",
        spec: "@openclaw/codex@latest",
        resolvedName: "@openclaw/codex",
        resolvedVersion: "2026.5.30-beta.1",
      },
    });

    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "codex",
            name: "Codex",
            status: "loaded",
            format: "bundle",
            bundleCapabilities: ["provider:codex"],
          }),
        ],
      }),
      [],
      { env: { OPENCLAW_HOME: "/tmp/test-openclaw" } },
    );
    try {
      const driftCalls = noteSpy.mock.calls.filter(([, title]) => title === "Plugin version drift");
      expect(driftCalls).toHaveLength(1);
      const [[body]] = driftCalls;
      expect(body).toContain("not on gateway 2026.6.1");
      expect(body).toContain("codex: 2026.5.30-beta.1 -> expected 2026.6.1");
      expect(body).toContain("openclaw plugins update <plugin-id>");
    } finally {
      noteSpy.mockRestore();
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    }
  });
});
