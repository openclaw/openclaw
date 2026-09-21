import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { MemoryWorkspaceMaintenance } from "../../../packages/memory-host-sdk/src/host/workspace-files.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import {
  getRuntimeConfig,
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  getMemorySearchManager,
  loadPluginManifestRegistryCore,
  getAgentWorkspaceAccess,
  previewGroundedRemMarkdown,
  dedupeDreamDiaryEntries,
  writeBackfillDiaryEntries,
  removeBackfillDiaryEntries,
  removeGroundedShortTermCandidates,
  repairDreamingArtifacts,
  DOCTOR_MEMORY_TARGET_METHODS,
  invokeDoctorMemory,
  expectRecordFields,
  respondPayload,
  mockCallArg,
} from "./doctor.test-support.js";

describe("doctor.memory agent targeting", () => {
  beforeEach(() => {
    getRuntimeConfig.mockReset().mockReturnValue({});
    listAgentIds.mockClear();
    resolveDefaultAgentId.mockReset().mockReturnValue("main");
    resolveAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw");
    getMemorySearchManager.mockReset().mockResolvedValue({
      manager: null,
      error: "memory search unavailable",
    });
    loadPluginManifestRegistryCore.mockReset().mockReturnValue({ plugins: [], diagnostics: [] });
    removeBackfillDiaryEntries.mockReset().mockResolvedValue({ removed: 0 });
    removeGroundedShortTermCandidates.mockReset().mockResolvedValue({ removed: 0 });
    repairDreamingArtifacts.mockReset().mockResolvedValue({
      changed: false,
      archivedDreamsDiary: false,
      archivedSessionCorpus: false,
      archivedSessionIngestion: false,
      warnings: [],
    });
    dedupeDreamDiaryEntries.mockReset().mockResolvedValue({ removed: 0, kept: 0 });
  });

  it.each(DOCTOR_MEMORY_TARGET_METHODS)(
    "%s returns typed selection-required when agentId is omitted",
    async (method) => {
      getRuntimeConfig.mockReturnValue({
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      });
      resolveDefaultAgentId.mockImplementationOnce(() => {
        throw new AgentSelectionRequiredError(["ops", "research"], {
          surface: "doctor memory",
          hint: "Pass agentId to select a configured agent.",
        });
      });
      const respond = vi.fn();

      await invokeDoctorMemory(method, respond, { includeCron: true });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: expect.stringContaining("agent"),
        }),
      );
      expect(resolveAgentWorkspaceDir).not.toHaveBeenCalled();
    },
  );

  it.each(DOCTOR_MEMORY_TARGET_METHODS)(
    "%s rejects an unknown agent before resolving agent state",
    async (method) => {
      const respond = vi.fn();

      await invokeDoctorMemory(method, respond, {
        params: { agentId: "invented" },
        includeCron: true,
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, 'unknown agent id "invented"'),
      );
      expect(getMemorySearchManager).not.toHaveBeenCalled();
      expect(resolveAgentWorkspaceDir).not.toHaveBeenCalled();
    },
  );

  it.each(DOCTOR_MEMORY_TARGET_METHODS)(
    "%s rejects a non-string agentId before resolving the default agent",
    async (method) => {
      const respond = vi.fn();

      await invokeDoctorMemory(method, respond, {
        params: { agentId: 42 },
        includeCron: true,
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agentId must be a string"),
      );
      expect(getMemorySearchManager).not.toHaveBeenCalled();
      expect(resolveAgentWorkspaceDir).not.toHaveBeenCalled();
    },
  );
});

describe("doctor.memory dream actions", () => {
  it("clears grounded-only staged short-term entries without touching the diary", async () => {
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw");
    removeGroundedShortTermCandidates.mockResolvedValue({
      removed: 3,
      storePath: "/tmp/openclaw/memory/.dreams/short-term-recall.json",
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.resetGroundedShortTerm", respond);

    expect(removeGroundedShortTermCandidates).toHaveBeenCalledWith({
      workspaceDir: "/tmp/openclaw",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        action: "resetGroundedShortTerm",
        removedShortTermEntries: 3,
      },
      undefined,
    );
  });

  it("repairs contaminated dreaming artifacts for control-ui callers", async () => {
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw");
    repairDreamingArtifacts.mockResolvedValue({
      changed: true,
      archiveDir: "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-00-00-000Z",
      archivedDreamsDiary: false,
      archivedSessionCorpus: true,
      archivedSessionIngestion: true,
      archivedPaths: [],
      warnings: [],
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.repairDreamingArtifacts", respond);

    expect(repairDreamingArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/openclaw",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        action: "repairDreamingArtifacts",
        changed: true,
        archiveDir: "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-00-00-000Z",
        archivedDreamsDiary: false,
        archivedSessionCorpus: true,
        archivedSessionIngestion: true,
        warnings: [],
      },
      undefined,
    );
  });

  it("dedupes exact dream diary duplicates for control-ui callers", async () => {
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw");
    dedupeDreamDiaryEntries.mockResolvedValue({
      dreamsPath: "/tmp/openclaw/DREAMS.md",
      removed: 2,
      kept: 7,
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.dedupeDreamDiary", respond);

    expect(dedupeDreamDiaryEntries).toHaveBeenCalledWith({
      workspaceDir: "/tmp/openclaw",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        action: "dedupeDreamDiary",
        path: "DREAMS.md",
        found: false,
        removedEntries: 2,
        dedupedEntries: 2,
        keptEntries: 7,
      },
      undefined,
    );
  });
});

describe("doctor.memory.dreamDiary", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    getRuntimeConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw");
    previewGroundedRemMarkdown.mockReset();
    writeBackfillDiaryEntries.mockReset();
    removeBackfillDiaryEntries.mockReset();
  });

  it("reads the Harness diary instead of a stale Gateway copy", async () => {
    const workspaceDir = tempDirs.make("doctor-remote-diary-");
    await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "stale Gateway diary");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const stat = vi.fn<MemoryWorkspaceMaintenance["stat"]>().mockResolvedValue({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      size: 20,
      mtimeMs: 1234,
      mode: 0o600,
    });
    const readFile = vi
      .fn<MemoryWorkspaceMaintenance["readFile"]>()
      .mockResolvedValue(Buffer.from("current Harness diary"));
    const listDirectory = vi.fn<MemoryWorkspaceMaintenance["listDirectory"]>();
    getAgentWorkspaceAccess.mockReturnValue({
      memoryFiles: { maintenance: { stat, readFile, listDirectory } },
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.dreamDiary", respond);

    expect(getAgentWorkspaceAccess).toHaveBeenCalledWith(workspaceDir, "memoryFiles");
    expect(stat).toHaveBeenCalledWith(path.join(workspaceDir, "DREAMS.md"), false);
    expect(readFile).toHaveBeenCalledWith(path.join(workspaceDir, "DREAMS.md"));
    expectRecordFields(respondPayload(respond), {
      found: true,
      content: "current Harness diary",
      updatedAtMs: 1234,
    });
  });

  it("does not read symlinked Harness diaries", async () => {
    const stat = vi.fn<MemoryWorkspaceMaintenance["stat"]>().mockResolvedValue({
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
      size: 10,
      mtimeMs: 1234,
      mode: 0o777,
    });
    const readFile = vi.fn<MemoryWorkspaceMaintenance["readFile"]>();
    const listDirectory = vi.fn<MemoryWorkspaceMaintenance["listDirectory"]>();
    getAgentWorkspaceAccess.mockReturnValue({
      memoryFiles: { maintenance: { stat, readFile, listDirectory } },
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.dreamDiary", respond);

    expect(stat).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalled();
    expectRecordFields(respondPayload(respond), { found: false });
  });

  it("backfills using Harness daily files when Gateway has no workspace files", async () => {
    const workspaceDir = tempDirs.make("doctor-remote-backfill-");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const stat = vi.fn<MemoryWorkspaceMaintenance["stat"]>().mockResolvedValue({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      size: 20,
      mtimeMs: 1234,
      mode: 0o600,
    });
    const readFile = vi
      .fn<MemoryWorkspaceMaintenance["readFile"]>()
      .mockResolvedValue(Buffer.from("updated Harness diary"));
    const listDirectory = vi.fn<MemoryWorkspaceMaintenance["listDirectory"]>().mockResolvedValue([
      { name: "2026-02-19.md", isFile: true, isDirectory: false, isSymbolicLink: false },
      { name: "notes.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
    ]);
    getAgentWorkspaceAccess.mockReturnValue({
      memoryFiles: { maintenance: { stat, readFile, listDirectory } },
    });
    previewGroundedRemMarkdown.mockResolvedValue({
      scannedFiles: 1,
      files: [
        {
          path: "memory/2026-02-19.md",
          renderedMarkdown: "What Happened\n1. Durable preference\n",
        },
      ],
    });
    writeBackfillDiaryEntries.mockResolvedValue({
      dreamsPath: path.join(workspaceDir, "DREAMS.md"),
      written: 1,
      replaced: 0,
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.backfillDreamDiary", respond);

    expect(listDirectory).toHaveBeenCalledWith(path.join(workspaceDir, "memory"));
    expect(previewGroundedRemMarkdown).toHaveBeenCalledWith({
      workspaceDir,
      inputPaths: [path.join(workspaceDir, "memory", "2026-02-19.md")],
    });
    expectRecordFields(respondPayload(respond), { scannedFiles: 1, written: 1 });
  });

  it("does not fall back to Gateway files when remote maintenance is unavailable", async () => {
    const workspaceDir = tempDirs.make("doctor-remote-unavailable-");
    await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "stale Gateway diary");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    getAgentWorkspaceAccess.mockReturnValue({ memoryFiles: {} });
    const respond = vi.fn();

    await expect(invokeDoctorMemory("doctor.memory.dreamDiary", respond)).rejects.toThrow(
      "Remote Memory maintenance is unavailable",
    );
    expect(respond).not.toHaveBeenCalled();
  });

  it("reads local DREAMS.md when the workspace provider has no Memory capability", async () => {
    getAgentWorkspaceAccess.mockReturnValue({});
    const workspaceDir = tempDirs.make("doctor-dream-diary-upper-");
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(diaryPath, "## Dream Diary\n- staged durable memory\n", "utf-8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.dreamDiary", respond);
    const payload = respondPayload(respond);
    expectRecordFields(payload, {
      agentId: "main",
      found: true,
      path: "DREAMS.md",
      content: "## Dream Diary\n- staged durable memory\n",
    });
    expect(typeof payload.updatedAtMs).toBe("number");
  });

  it("reads DREAMS.md for the requested agent", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-agent-"));
    await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "## Research Dreams\n", "utf-8");
    resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) =>
      agentId === "research-analyst" ? workspaceDir : "/tmp/openclaw",
    );
    const respond = vi.fn();

    try {
      await invokeDoctorMemory("doctor.memory.dreamDiary", respond, {
        params: { agentId: "research-analyst" },
      });
      expect(resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.anything(), "research-analyst");
      const payload = respondPayload(respond);
      expectRecordFields(payload, {
        agentId: "research-analyst",
        found: true,
        path: "DREAMS.md",
        content: "## Research Dreams\n",
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reads lowercase dreams.md when present", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-lower-"));
    await fs.writeFile(path.join(workspaceDir, "dreams.md"), "lowercase diary\n", "utf-8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    try {
      await invokeDoctorMemory("doctor.memory.dreamDiary", respond);
      const payload = respondPayload(respond);
      expectRecordFields(payload, {
        agentId: "main",
        found: true,
        content: "lowercase diary\n",
      });
      expect(typeof payload.updatedAtMs).toBe("number");
      expect(["DREAMS.md", "dreams.md"]).toContain(payload.path);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("returns not-found payload when no dream diary exists", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-missing-"));
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    try {
      await invokeDoctorMemory("doctor.memory.dreamDiary", respond);
      expectRecordFields(respondPayload(respond), {
        agentId: "main",
        found: false,
        path: "DREAMS.md",
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("backfills the dream diary from workspace memory files", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-backfill-"));
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-02-19.md"), "source\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "# Dream Diary\n", "utf-8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    previewGroundedRemMarkdown.mockResolvedValue({
      scannedFiles: 1,
      files: [
        {
          path: path.join(workspaceDir, "memory", "2026-02-19.md"),
          renderedMarkdown: "What Happened\n1. Bunji — partner\n",
        },
      ],
    });
    writeBackfillDiaryEntries.mockResolvedValue({
      dreamsPath: path.join(workspaceDir, "DREAMS.md"),
      written: 1,
      replaced: 1,
    });
    const respond = vi.fn();

    try {
      await invokeDoctorMemory("doctor.memory.backfillDreamDiary", respond);
      expect(previewGroundedRemMarkdown).toHaveBeenCalledWith({
        workspaceDir,
        inputPaths: [path.join(workspaceDir, "memory", "2026-02-19.md")],
      });
      const writeInput = mockCallArg(writeBackfillDiaryEntries);
      const entry = expectDefined(
        (writeInput.entries as Array<Record<string, unknown>>)[0],
        "(writeInput.entries as Array<Record<string, unknown>>)[0] test invariant",
      );
      expect(entry.bodyLines).toContain("What Happened");
      expect(entry.bodyLines).toContain("1. Bunji — partner");
      expectRecordFields(respondPayload(respond), {
        agentId: "main",
        action: "backfill",
        scannedFiles: 1,
        written: 1,
        replaced: 1,
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("backfills the dream diary from slugged workspace memory files", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "doctor-dream-diary-backfill-slugged-"),
    );
    const sourcePath = path.join(workspaceDir, "memory", "2026-02-19-vendor-pitch.md");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(sourcePath, "source\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "# Dream Diary\n", "utf-8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    previewGroundedRemMarkdown.mockResolvedValue({
      scannedFiles: 1,
      files: [
        {
          path: sourcePath,
          renderedMarkdown: "What Happened\n1. Vendor pitch — rejected\n",
        },
      ],
    });
    writeBackfillDiaryEntries.mockResolvedValue({
      dreamsPath: path.join(workspaceDir, "DREAMS.md"),
      written: 1,
      replaced: 1,
    });
    const respond = vi.fn();

    try {
      await invokeDoctorMemory("doctor.memory.backfillDreamDiary", respond);
      expect(previewGroundedRemMarkdown).toHaveBeenCalledWith({
        workspaceDir,
        inputPaths: [sourcePath],
      });
      const writeInput = mockCallArg(writeBackfillDiaryEntries);
      expect(writeInput.workspaceDir).toBe(workspaceDir);
      const entry = expectDefined(
        (writeInput.entries as Array<Record<string, unknown>>)[0],
        "(writeInput.entries as Array<Record<string, unknown>>)[0] test invariant",
      );
      expectRecordFields(entry, {
        isoDay: "2026-02-19",
        sourcePath,
      });
      expect(entry.bodyLines).toContain("What Happened");
      expect(entry.bodyLines).toContain("1. Vendor pitch — rejected");
      expectRecordFields(respondPayload(respond), {
        agentId: "main",
        action: "backfill",
        scannedFiles: 1,
        written: 1,
        replaced: 1,
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("no-ops backfill when the workspace has no daily memory files", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-empty-"));
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    const respond = vi.fn();

    try {
      await invokeDoctorMemory("doctor.memory.backfillDreamDiary", respond);
      expect(previewGroundedRemMarkdown).not.toHaveBeenCalled();
      expect(writeBackfillDiaryEntries).not.toHaveBeenCalled();
      expectRecordFields(respondPayload(respond), {
        agentId: "main",
        action: "backfill",
        scannedFiles: 0,
        written: 0,
        replaced: 0,
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("resets only backfilled dream diary entries", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-dream-diary-reset-"));
    await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "# Dream Diary\n", "utf-8");
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    removeBackfillDiaryEntries.mockResolvedValue({
      dreamsPath: path.join(workspaceDir, "DREAMS.md"),
      removed: 3,
    });
    const respond = vi.fn();

    try {
      await invokeDoctorMemory("doctor.memory.resetDreamDiary", respond);
      expect(removeBackfillDiaryEntries).toHaveBeenCalledWith({ workspaceDir });
      expectRecordFields(respondPayload(respond), {
        agentId: "main",
        action: "reset",
        removedEntries: 3,
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
