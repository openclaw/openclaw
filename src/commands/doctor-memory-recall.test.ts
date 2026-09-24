import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());
const listAgentIds = vi.hoisted(() =>
  vi.fn<(cfg: { agents?: { list?: Array<{ id: string }> } }) => string[]>(),
);
const resolveAgentDir = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(() => "/tmp/agent-default"),
);
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(() => "/tmp/agent-default/workspace"),
);
const getActiveMemorySearchManagerCore = vi.hoisted(() => vi.fn());
const auditDreamingArtifacts = vi.hoisted(() => vi.fn());
const auditShortTermPromotionArtifacts = vi.hoisted(() => vi.fn());
const repairDreamingArtifacts = vi.hoisted(() => vi.fn());
const repairShortTermPromotionArtifacts = vi.hoisted(() => vi.fn());
const maybeRepairWorkspaceMemoryHealth = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
}));
vi.mock("../plugins/memory-runtime.js", () => ({ getActiveMemorySearchManagerCore }));
vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  auditDreamingArtifacts,
  auditShortTermPromotionArtifacts,
  repairDreamingArtifacts,
  repairShortTermPromotionArtifacts,
}));
vi.mock("./doctor-workspace.js", () => ({ maybeRepairWorkspaceMemoryHealth }));

import { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth } from "./doctor-memory-recall.js";

function shortTermAudit(overrides: Record<string, unknown> = {}) {
  return {
    storePath: "/tmp/agent-default/workspace/memory/.dreams/short-term-recall.json",
    lockPath: "/tmp/agent-default/workspace/memory/.dreams/short-term-promotion.lock",
    exists: true,
    entryCount: 1,
    promotedCount: 0,
    spacedEntryCount: 0,
    conceptTaggedEntryCount: 1,
    invalidEntryCount: 0,
    issues: [],
    ...overrides,
  };
}

function dreamingAudit(overrides: Record<string, unknown> = {}) {
  return {
    sessionCorpusDir: "/tmp/agent-default/workspace/memory/.dreams/session-corpus",
    sessionCorpusFileCount: 0,
    suspiciousSessionCorpusFileCount: 0,
    suspiciousSessionCorpusLineCount: 0,
    sessionIngestionPath: "/tmp/agent-default/workspace/memory/.dreams/session-ingestion.json",
    sessionIngestionExists: false,
    issues: [],
    ...overrides,
  };
}

function resetMemoryRecallMocks() {
  auditShortTermPromotionArtifacts.mockReset();
  auditShortTermPromotionArtifacts.mockResolvedValue(shortTermAudit());
  auditDreamingArtifacts.mockReset();
  auditDreamingArtifacts.mockResolvedValue(dreamingAudit());
  repairDreamingArtifacts.mockReset();
  repairDreamingArtifacts.mockResolvedValue({
    changed: false,
    archivedDreamsDiary: false,
    archivedSessionCorpus: false,
    archivedSessionIngestion: false,
    archivedPaths: [],
    warnings: [],
  });
  repairShortTermPromotionArtifacts.mockReset();
  repairShortTermPromotionArtifacts.mockResolvedValue({
    changed: false,
    removedInvalidEntries: 0,
    removedOverflowEntries: 0,
    rewroteStore: false,
    removedStaleLock: false,
  });
  maybeRepairWorkspaceMemoryHealth.mockClear();
}

function expectFirstNoteContains(...values: string[]) {
  const message = String(note.mock.calls[0]?.[0] ?? "");
  for (const value of values) {
    expect(message).toContain(value);
  }
}

describe("memory recall doctor integration", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    note.mockClear();
    listAgentIds.mockImplementation(
      (config: { agents?: { list?: Array<{ id: string }> } }) =>
        config.agents?.list?.map((agent) => agent.id) ?? ["agent-default"],
    );
    resetMemoryRecallMocks();
    getActiveMemorySearchManagerCore.mockResolvedValue({
      manager: {
        status: () => ({ workspaceDir: "/tmp/agent-default/workspace", backend: "builtin" }),
        close: vi.fn(async () => {}),
      },
    });
  });

  function createPrompter(overrides: Partial<DoctorPrompter> = {}): DoctorPrompter {
    return {
      confirm: vi.fn(async () => true),
      confirmAutoFix: vi.fn(async () => true),
      confirmAggressiveAutoFix: vi.fn(async () => true),
      confirmRuntimeRepair: vi.fn(async () => true),
      select: vi.fn(async (_params, fallback) => fallback),
      shouldRepair: true,
      shouldForce: false,
      repairMode: {
        shouldRepair: true,
        shouldForce: false,
        nonInteractive: false,
        canPrompt: true,
        updateInProgress: false,
      },
      ...overrides,
    };
  }

  it("notes recall-store audit problems with doctor guidance", async () => {
    auditShortTermPromotionArtifacts.mockResolvedValueOnce(
      shortTermAudit({
        entryCount: 12,
        promotedCount: 4,
        spacedEntryCount: 2,
        conceptTaggedEntryCount: 10,
        invalidEntryCount: 1,
        issues: [
          {
            severity: "warn",
            code: "recall-store-invalid",
            message: "Short-term recall store contains 1 invalid entry.",
            fixable: true,
          },
          {
            severity: "warn",
            code: "recall-lock-stale",
            message: "Short-term promotion lock appears stale.",
            fixable: true,
          },
        ],
      }),
    );

    await noteMemoryRecallHealth(cfg);

    expect(auditShortTermPromotionArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/agent-default/workspace",
    });
    expect(note).toHaveBeenCalledTimes(2);
    expectFirstNoteContains(
      "Memory recall artifacts need attention:",
      "doctor --fix",
      "memory status --fix",
    );
    expect(String(note.mock.calls[1]?.[0] ?? "")).toContain("Dreaming: enabled");
  });

  it("runs memory recall repair during doctor --fix", async () => {
    auditShortTermPromotionArtifacts.mockResolvedValueOnce(
      shortTermAudit({
        entryCount: 12,
        promotedCount: 4,
        spacedEntryCount: 2,
        conceptTaggedEntryCount: 10,
        invalidEntryCount: 1,
        issues: [
          {
            severity: "warn",
            code: "recall-store-invalid",
            message: "Short-term recall store contains 1 invalid entry.",
            fixable: true,
          },
        ],
      }),
    );
    repairShortTermPromotionArtifacts.mockResolvedValueOnce({
      changed: true,
      removedInvalidEntries: 1,
      removedOverflowEntries: 0,
      rewroteStore: true,
      removedStaleLock: true,
    });
    const prompter = createPrompter();

    await maybeRepairMemoryRecallHealth({ cfg, prompter });

    expect(maybeRepairWorkspaceMemoryHealth).toHaveBeenCalledWith({
      cfg,
      prompter,
      scope: {
        agentId: "agent-default",
        workspaceDir: "/tmp/agent-default/workspace",
        labelAgent: false,
      },
    });
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalled();
    expect(repairShortTermPromotionArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/agent-default/workspace",
    });
    expect(note).toHaveBeenCalledTimes(1);
    expectFirstNoteContains(
      "Memory recall artifacts repaired:",
      "rewrote recall store",
      "removed stale promotion lock",
    );
  });

  it("runs dreaming artifact repair during doctor --fix", async () => {
    auditDreamingArtifacts.mockResolvedValueOnce(
      dreamingAudit({
        sessionCorpusFileCount: 2,
        suspiciousSessionCorpusFileCount: 1,
        suspiciousSessionCorpusLineCount: 3,
        sessionIngestionExists: true,
        issues: [
          {
            severity: "warn",
            code: "dreaming-session-corpus-self-ingested",
            message:
              "Dreaming session corpus appears to contain self-ingested narrative content (3 suspicious lines).",
            fixable: true,
          },
        ],
      }),
    );
    repairDreamingArtifacts.mockResolvedValueOnce({
      changed: true,
      archiveDir: "/tmp/agent-default/workspace/.openclaw-repair/dreaming/2026-04-11T21-35-00-000Z",
      archivedDreamsDiary: false,
      archivedSessionCorpus: true,
      archivedSessionIngestion: true,
      archivedPaths: [],
      warnings: [],
    });
    const prompter = createPrompter();

    await maybeRepairMemoryRecallHealth({ cfg, prompter });

    expect(maybeRepairWorkspaceMemoryHealth).toHaveBeenCalledWith({
      cfg,
      prompter,
      scope: {
        agentId: "agent-default",
        workspaceDir: "/tmp/agent-default/workspace",
        labelAgent: false,
      },
    });
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalled();
    expect(repairDreamingArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/agent-default/workspace",
    });
    const message = String(note.mock.calls[note.mock.calls.length - 1]?.[0] ?? "");
    expect(message).toContain("Dreaming artifacts repaired:");
    expect(message).toContain("archived session corpus");
    expect(message).toContain("archived session-ingestion state");
  });

  it("audits and repairs each agent with isolated managers and paths", async () => {
    getActiveMemorySearchManagerCore.mockClear();
    listAgentIds.mockReturnValue(["agent-default", "secondary"]);
    resolveAgentDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}/workspace`);
    const closes = new Map<string, ReturnType<typeof vi.fn>>();
    getActiveMemorySearchManagerCore.mockImplementation(async ({ agentId }) => {
      const close = vi.fn(async () => {});
      closes.set(agentId, close);
      return {
        manager: {
          status: () => ({ workspaceDir: `/tmp/${agentId}/workspace`, backend: "builtin" }),
          close,
        },
      };
    });
    auditShortTermPromotionArtifacts.mockImplementation(async ({ workspaceDir }) =>
      shortTermAudit({
        storePath: `${workspaceDir}/memory/.dreams/short-term-recall.json`,
        lockPath: `${workspaceDir}/memory/.dreams/short-term-promotion.lock`,
        invalidEntryCount: workspaceDir.includes("secondary") ? 1 : 0,
        issues: workspaceDir.includes("secondary")
          ? [
              {
                severity: "warn",
                code: "recall-store-invalid",
                message: "Secondary recall is invalid.",
                fixable: true,
              },
            ]
          : [],
      }),
    );
    repairShortTermPromotionArtifacts.mockResolvedValue({
      changed: true,
      removedInvalidEntries: 1,
      removedOverflowEntries: 0,
      rewroteStore: true,
      removedStaleLock: false,
    });
    const prompter = createPrompter();

    await maybeRepairMemoryRecallHealth({ cfg, prompter });

    expect(getActiveMemorySearchManagerCore).toHaveBeenCalledTimes(2);
    expect(closes.get("agent-default")).toHaveBeenCalledOnce();
    expect(closes.get("secondary")).toHaveBeenCalledOnce();
    expect(repairShortTermPromotionArtifacts).toHaveBeenCalledTimes(1);
    expect(repairShortTermPromotionArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/secondary/workspace",
    });
    expect(String(note.mock.calls.at(-1)?.[0])).toContain('Agent "secondary":');
  });
});
