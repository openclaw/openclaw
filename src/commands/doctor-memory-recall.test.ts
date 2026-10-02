import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());
const listAgentIds = vi.hoisted(() => vi.fn<(cfg: OpenClawConfig) => string[]>());
const resolveAgentDir = vi.hoisted(() =>
  vi.fn((_cfg: OpenClawConfig, agentId: string) => `/tmp/${agentId}`),
);
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg: OpenClawConfig, agentId: string) => `/tmp/${agentId}/workspace`),
);
const getActiveMemorySearchManagerCore = vi.hoisted(() => vi.fn());
const resolveActiveMemoryBackendConfig = vi.hoisted(() =>
  vi.fn<() => { backend: "builtin" } | { backend: "provider-runtime"; providerId: string }>(() => ({
    backend: "builtin",
  })),
);
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
vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManagerCore,
  resolveActiveMemoryBackendConfig,
}));
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
  resolveActiveMemoryBackendConfig.mockReset().mockReturnValue({ backend: "builtin" });
  auditShortTermPromotionArtifacts.mockReset().mockResolvedValue(shortTermAudit());
  auditDreamingArtifacts.mockReset().mockResolvedValue(dreamingAudit());
  repairDreamingArtifacts.mockReset().mockResolvedValue({
    changed: false,
    archivedDreamsDiary: false,
    archivedSessionCorpus: false,
    archivedSessionIngestion: false,
    archivedPaths: [],
    warnings: [],
  });
  repairShortTermPromotionArtifacts.mockReset().mockResolvedValue({
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
  const cfg: OpenClawConfig = {};
  const closes = new Map<string, ReturnType<typeof vi.fn>>();

  beforeEach(() => {
    note.mockClear();
    listAgentIds.mockReturnValue(["agent-default"]);
    resetMemoryRecallMocks();
    closes.clear();
    getActiveMemorySearchManagerCore.mockReset().mockImplementation(async ({ agentId }) => {
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

  it("notes that Memory Core recall audits do not apply to native providers", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue({
      backend: "provider-runtime",
      providerId: "records",
    });

    await noteMemoryRecallHealth(cfg);

    expect(String(note.mock.calls[0]?.[0] ?? "")).toContain(
      "Not applicable: records uses the provider runtime; see its health.",
    );
    expect(auditShortTermPromotionArtifacts).not.toHaveBeenCalled();
    expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
  });

  function createPrompter(): DoctorPrompter {
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
    listAgentIds.mockReturnValue(["agent-default", "secondary"]);
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
      removedStaleLock: true,
    });
    const prompter = createPrompter();

    await maybeRepairMemoryRecallHealth({ cfg, prompter });

    expect(getActiveMemorySearchManagerCore).toHaveBeenCalledTimes(2);
    expect(closes.get("agent-default")).toHaveBeenCalledOnce();
    expect(closes.get("secondary")).toHaveBeenCalledOnce();
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledOnce();
    expect(repairShortTermPromotionArtifacts).toHaveBeenCalledTimes(1);
    expect(repairShortTermPromotionArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/secondary/workspace",
    });
    expect(note).toHaveBeenCalledOnce();
    expectFirstNoteContains(
      'Agent "secondary":',
      "Memory recall artifacts repaired:",
      "rewrote recall store",
      "removed stale promotion lock",
    );
  });
});
