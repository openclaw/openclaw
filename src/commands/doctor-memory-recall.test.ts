import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createDoctorPrompterFixture as createPrompter } from "../flows/doctor-health-context.test-support.js";

const { note, agentIds, memory, artifacts, workspace } = vi.hoisted(() => ({
  note: vi.fn(),
  agentIds: vi.fn<(cfg: OpenClawConfig) => string[]>(),
  memory: {
    getActiveMemorySearchManagerCore: vi.fn(),
    resolveActiveMemoryBackendConfig:
      vi.fn<() => { backend: "builtin" } | { backend: "provider-runtime"; providerId: string }>(),
  },
  artifacts: {
    auditDreamingArtifacts: vi.fn(),
    auditShortTermPromotionArtifacts: vi.fn(),
    repairDreamingArtifacts: vi.fn(),
    repairShortTermPromotionArtifacts: vi.fn(),
  },
  workspace: { maybeRepairWorkspaceMemoryHealth: vi.fn(async () => undefined) },
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
// mock-isolation: Keep agent discovery and directories inside the synthetic fixture.
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: agentIds,
  resolveAgentDir: (_cfg: OpenClawConfig, id: string) => `/tmp/${id}`,
  resolveAgentWorkspaceDir: (_cfg: OpenClawConfig, id: string) => `/tmp/${id}/workspace`,
}));
// mock-isolation: Exercise Doctor backend selection without starting a real memory runtime.
vi.mock("../plugins/memory-runtime.js", () => memory);
// mock-isolation: Supply artifact health results without reading or repairing real memory files.
vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => artifacts);
// mock-isolation: Observe repair delegation without mutating a real workspace.
vi.mock("./doctor-workspace.js", () => workspace);
import { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth } from "./doctor-memory-recall.js";

const warning = (message: string) => ({ message, fixable: true });
const audit = (issues: ReturnType<typeof warning>[] = []) => ({
  storePath: "/tmp/agent-default/workspace/memory/.dreams/short-term-recall.json",
  issues,
});
const closes = new Map<string, ReturnType<typeof vi.fn>>();
function expectNotes(...values: string[]) {
  const output = note.mock.calls.map(([message]) => String(message)).join("\n");
  for (const value of values) {
    expect(output).toContain(value);
  }
}
beforeEach(() => {
  for (const mock of [
    note,
    agentIds,
    ...Object.values(memory),
    ...Object.values(artifacts),
    workspace.maybeRepairWorkspaceMemoryHealth,
  ]) {
    mock.mockReset();
  }
  closes.clear();
  agentIds.mockReturnValue(["agent-default"]);
  memory.resolveActiveMemoryBackendConfig.mockReturnValue({ backend: "builtin" });
  artifacts.auditShortTermPromotionArtifacts.mockResolvedValue(audit());
  artifacts.auditDreamingArtifacts.mockResolvedValue({ issues: [] });
  artifacts.repairDreamingArtifacts.mockResolvedValue({ changed: false });
  artifacts.repairShortTermPromotionArtifacts.mockResolvedValue({ changed: false });
  workspace.maybeRepairWorkspaceMemoryHealth.mockResolvedValue(undefined);
  memory.getActiveMemorySearchManagerCore.mockImplementation(async ({ agentId }) => {
    const close = vi.fn(async () => {});
    closes.set(agentId, close);
    return {
      manager: {
        status: () => ({ workspaceDir: `/tmp/${agentId}/workspace`, backend: "builtin" }),
        close,
      },
    };
  });
});

it.each(["provider-runtime", "builtin"] as const)("reports %s recall health", async (backend) => {
  if (backend === "provider-runtime") {
    memory.resolveActiveMemoryBackendConfig.mockReturnValue({ backend, providerId: "records" });
  }
  artifacts.auditShortTermPromotionArtifacts.mockResolvedValueOnce(
    audit([
      warning("Short-term recall store contains 1 invalid entry."),
      warning("Short-term promotion lock appears stale."),
    ]),
  );
  await noteMemoryRecallHealth({});
  expectNotes("Dreaming:");
  if (backend === "provider-runtime") {
    expect(artifacts.auditShortTermPromotionArtifacts).not.toHaveBeenCalled();
    expect(memory.getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  } else {
    expectNotes("Memory recall artifacts need attention:", "doctor --fix", "memory status --fix");
  }
});

it.each(["dreaming", "recall"] as const)(
  "repairs %s artifacts with isolated agent paths",
  async (kind) => {
    const dreaming = kind === "dreaming";
    const agentId = dreaming ? "agent-default" : "secondary";
    agentIds.mockReturnValue(dreaming ? [agentId] : ["agent-default", agentId]);
    if (dreaming) {
      artifacts.auditDreamingArtifacts.mockResolvedValueOnce({
        issues: [warning("Self-ingested narrative content.")],
      });
      artifacts.repairDreamingArtifacts.mockResolvedValueOnce({
        changed: true,
        archiveDir: "/tmp/dreaming-archive",
        archivedSessionCorpus: true,
        archivedSessionIngestion: true,
        warnings: [],
      });
    } else {
      artifacts.auditShortTermPromotionArtifacts.mockImplementation(async ({ workspaceDir }) =>
        audit(workspaceDir.includes("secondary") ? [warning("Secondary recall is invalid.")] : []),
      );
      artifacts.repairShortTermPromotionArtifacts.mockResolvedValue({
        changed: true,
        removedInvalidEntries: 1,
        rewroteStore: true,
        removedStaleLock: true,
      });
    }
    const prompter = createPrompter(true, true);
    await maybeRepairMemoryRecallHealth({ cfg: {}, prompter });
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledOnce();
    const repair = dreaming
      ? artifacts.repairDreamingArtifacts
      : artifacts.repairShortTermPromotionArtifacts;
    expect(repair).toHaveBeenCalledExactlyOnceWith({ workspaceDir: `/tmp/${agentId}/workspace` });
    for (const close of closes.values()) {
      expect(close).toHaveBeenCalledOnce();
    }
    if (dreaming) {
      expect(workspace.maybeRepairWorkspaceMemoryHealth).toHaveBeenCalledWith({
        prompter,
        scope: { agentId, workspaceDir: `/tmp/${agentId}/workspace`, labelAgent: false },
      });
      expectNotes(
        "Dreaming artifacts repaired:",
        "archived session corpus",
        "archived session-ingestion state",
      );
    } else {
      expect(memory.getActiveMemorySearchManagerCore).toHaveBeenCalledTimes(2);
      expect([...closes.keys()]).toEqual(["agent-default", "secondary"]);
      expectNotes(
        'Agent "secondary":',
        "Memory recall artifacts repaired:",
        "rewrote recall store",
        "removed stale promotion lock",
      );
    }
  },
);
