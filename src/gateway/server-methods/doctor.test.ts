import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { MemoryWorkspaceMaintenance } from "../../../packages/memory-host-sdk/src/host/workspace-files.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  expectObjectFields as expectRecordFields,
  mockFirstObjectArg as mockCallArg,
} from "../../test-utils/mock-call-assertions.js";
import {
  getRuntimeConfig,
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  getMemorySearchManager,
  getAgentWorkspaceAccess,
  previewGroundedRemMarkdown,
  dedupeDreamDiaryEntries,
  writeBackfillDiaryEntries,
  removeBackfillDiaryEntries,
  removeGroundedShortTermCandidates,
  repairDreamingArtifacts,
  loadShortTermPromotionDreamingStats,
  DOCTOR_MEMORY_TARGET_METHODS,
  invokeDoctorMemory,
  respondPayload,
  makeDreamingStats,
  makeDreamingEntry,
  useMemoryManagerFixture,
} from "./doctor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function dreamingConfig(
  agents?: OpenClawConfig["agents"],
  dreaming: Record<string, unknown> = {},
): OpenClawConfig {
  return { agents, plugins: { entries: { "memory-core": { config: { dreaming } } } } };
}

function useAgentWorkspaces(main: string, alpha: string) {
  resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) =>
    agentId === "alpha" ? alpha : main,
  );
}

function workspaces() {
  const root = tempDirs.make("doctor-memory-");
  const main = path.join(root, "main"),
    alpha = path.join(root, "alpha");
  useAgentWorkspaces(main, alpha);
  return { main, alpha, entries: { main: { workspace: main }, alpha: { workspace: alpha } } };
}

function useGemini(workspaceDir?: string) {
  return useMemoryManagerFixture({ status: () => ({ provider: "gemini", workspaceDir }) });
}

async function memoryPayload(
  method: Parameters<typeof invokeDoctorMemory>[0],
  options: Parameters<typeof invokeDoctorMemory>[2] = {},
) {
  const respond = vi.fn();
  await invokeDoctorMemory(method, respond, options);
  return respondPayload(respond);
}

const memoryStatus = (options: Parameters<typeof invokeDoctorMemory>[2] = {}) =>
  memoryPayload("doctor.memory.status", options);

async function diaryWorkspace(content = "stale Gateway diary") {
  const workspaceDir = tempDirs.make("doctor-diary-");
  await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), content);
  resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
  return workspaceDir;
}

function remoteDiary(content: string, symlink = false) {
  const stat = vi.fn<MemoryWorkspaceMaintenance["stat"]>().mockResolvedValue({
    isFile: !symlink,
    isDirectory: false,
    isSymbolicLink: symlink,
    size: symlink ? 10 : 20,
    mtimeMs: 1234,
    mode: symlink ? 0o777 : 0o600,
  });
  const readFile = vi.fn<MemoryWorkspaceMaintenance["readFile"]>();
  if (!symlink) {
    readFile.mockResolvedValue(Buffer.from(content));
  }
  const listDirectory = vi.fn<MemoryWorkspaceMaintenance["listDirectory"]>();
  getAgentWorkspaceAccess.mockReturnValue({
    memoryFiles: { maintenance: { stat, readFile, listDirectory } },
  });
  return { stat, readFile, listDirectory };
}

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
  });

  it.each([
    ["doctor.memory.status", {}, expect.stringContaining("agent"), true],
    ["doctor.memory.status", { agentId: 42 }, "agentId must be a string", false],
    ...DOCTOR_MEMORY_TARGET_METHODS.map(
      (method) => [method, { agentId: "invented" }, 'unknown agent id "invented"', false] as const,
    ),
  ] as const)(
    "rejects invalid agent selection for %s: %j",
    async (method, params, message, selectionRequired) => {
      if (selectionRequired) {
        getRuntimeConfig.mockReturnValue({
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        });
        resolveDefaultAgentId.mockImplementationOnce(() => {
          throw new AgentSelectionRequiredError(["ops", "research"], {
            surface: "doctor memory",
            hint: "Pass agentId to select a configured agent.",
          });
        });
      }
      const respond = vi.fn();
      await invokeDoctorMemory(method, respond, { params, includeCron: true });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        selectionRequired
          ? expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST, message })
          : errorShape(ErrorCodes.INVALID_REQUEST, message),
      );
      expect(getMemorySearchManager).not.toHaveBeenCalled();
      expect(resolveAgentWorkspaceDir).not.toHaveBeenCalled();
    },
  );
});

describe("doctor.memory.status", () => {
  beforeEach(() => {
    getRuntimeConfig.mockReset().mockReturnValue({});
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw");
    resolveMemorySearchConfig.mockReset().mockReturnValue({ enabled: true });
    getMemorySearchManager.mockReset();
    previewGroundedRemMarkdown.mockReset();
    dedupeDreamDiaryEntries.mockReset();
    writeBackfillDiaryEntries.mockReset();
    removeBackfillDiaryEntries.mockReset();
    removeGroundedShortTermCandidates.mockReset();
    repairDreamingArtifacts.mockReset();
    loadShortTermPromotionDreamingStats
      .mockReset()
      .mockImplementation(async () => makeDreamingStats());
  });

  it.each(["cached", "selected-plugin"] as const)(
    "returns %s embedding readiness and dreaming configuration",
    async (mode) => {
      if (mode === "selected-plugin") {
        getRuntimeConfig.mockReturnValue({
          plugins: {
            slots: { memory: "memos-local-openclaw-plugin" },
            entries: {
              "memos-local-openclaw-plugin": {
                config: { dreaming: { enabled: true, frequency: "0 */4 * * *" } },
              },
              "memory-core": { config: { dreaming: { enabled: false } } },
            },
          },
        });
      }
      const { close, probeEmbeddingAvailability } = useMemoryManagerFixture({
        status: () => ({ provider: "gemini" }),
        ...(mode === "cached"
          ? {
              probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: false }),
              getCachedEmbeddingAvailability: vi.fn(() => ({
                ok: true,
                checked: true,
                cached: true,
                checkedAtMs: 123,
                cacheExpiresAtMs: 456,
              })),
            }
          : {}),
      });
      const payload = await memoryStatus();
      const managerInput = mockCallArg(getMemorySearchManager);
      expect(managerInput.cfg).toBeDefined();
      expectRecordFields(managerInput, { agentId: "main", purpose: "status" });
      expectRecordFields(payload, { agentId: "main", provider: "gemini" });
      expect(probeEmbeddingAvailability).not.toHaveBeenCalled();
      expectRecordFields(
        payload.embedding,
        mode === "cached"
          ? { ok: true, checked: true, cached: true }
          : { ok: false, checked: false },
      );
      expect(payload.dreaming).toMatchObject({
        enabled: true,
        shortTermCount: 0,
        totalSignalCount: 0,
        phaseSignalCount: 0,
        promotedTotal: 0,
        promotedToday: 0,
        shortTermEntries: [],
        signalEntries: [],
        promotedEntries: [],
        phases: {
          deep: {
            managedCronPresent: false,
            ...(mode === "selected-plugin" ? { cron: "0 */4 * * *" } : {}),
          },
        },
      });
      expect(close).toHaveBeenCalled();
    },
  );

  it("orders dreaming entries deterministically when one timestamp is malformed", async () => {
    useGemini();
    const recentIso = "2026-04-04T00:00:00.000Z";
    loadShortTermPromotionDreamingStats.mockImplementation(async () =>
      makeDreamingStats({
        shortTermCount: 2,
        shortTermEntries: [
          makeDreamingEntry("memory/malformed.md", {
            snippet: "malformed timestamp entry",
            totalSignalCount: 5,
            lastRecalledAt: "not-a-valid-date",
          }),
          makeDreamingEntry("memory/recent.md", {
            snippet: "valid timestamp entry",
            totalSignalCount: 1,
            lastRecalledAt: recentIso,
          }),
        ],
      }),
    );

    expect((await memoryStatus()).dreaming).toMatchObject({
      shortTermEntries: [{ path: "memory/recent.md" }, { path: "memory/malformed.md" }],
    });
  });

  it("returns llama.cpp runtime facts created by the deep embedding probe", async () => {
    let probed = false;
    const runtime = {
      engine: "llama.cpp",
      state: "ready",
      backend: "cpu",
      buildInfo: "b10357 (689e227db)",
      model: { id: "embedding-model", path: "/models/embedding.gguf" },
      capabilities: { vision: false, draft: false },
      endpoints: { health: "ready", models: "ready", props: "ready", metrics: "ready" },
    };
    const { close } = useMemoryManagerFixture({
      status: () => ({
        provider: "local",
        ...(probed ? { custom: { llamaCppRuntime: runtime } } : {}),
      }),
      probeEmbeddingAvailability: vi.fn(async () => {
        probed = true;
        return { ok: true };
      }),
    });
    expect((await memoryStatus({ params: { probe: true } })).embeddingRuntime).toEqual(runtime);
    expect(close).toHaveBeenCalled();
  });

  it.each(["missing", "probe failure"] as const)(
    "reports %s memory manager errors",
    async (mode) => {
      const close =
        mode === "missing"
          ? undefined
          : useMemoryManagerFixture({
              status: () => ({ provider: "openai" }),
              probeEmbeddingAvailability: vi.fn().mockRejectedValue(new Error("timeout")),
            }).close;
      if (mode === "missing") {
        getMemorySearchManager.mockResolvedValue({
          manager: null,
          error: "memory search unavailable",
        });
      }
      expectRecordFields(await memoryStatus({ params: { probe: true } }), {
        agentId: "main",
        embedding: {
          ok: false,
          error:
            mode === "missing"
              ? "memory search unavailable"
              : "gateway memory check failed: timeout",
        },
      });
      if (close) {
        expect(close).toHaveBeenCalled();
      }
    },
  );

  it("includes dreaming counts and managed cron status when workspace data is available", async () => {
    const now = Date.parse("2026-04-05T00:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const recentIso = "2026-04-04T23:45:00.000Z";
    const olderIso = "2026-04-02T10:00:00.000Z";
    const { main, alpha, entries } = workspaces();
    getRuntimeConfig.mockReturnValue({
      memory: { search: { enabled: true } },
      ...dreamingConfig(
        {
          defaults: {
            systemAgent: { agentId: "main" },
            userTimezone: "America/Los_Angeles",
          },
          entries,
        },
        {
          enabled: true,
          frequency: "0 */4 * * *",
          phases: { deep: { recencyHalfLifeDays: 21, maxAgeDays: 30 } },
        },
      ),
    });
    const recalledEntry = makeDreamingEntry("memory/2026-04-03-1503.md", {
      snippet: "Emma prefers shorter, lower-pressure check-ins.",
      recallCount: 2,
      dailyCount: 1,
      totalSignalCount: 3,
      lightHits: 2,
      remHits: 3,
      phaseHitCount: 5,
      lastRecalledAt: recentIso,
    });
    const counts = {
      shortTermCount: 1,
      recallSignalCount: 2,
      dailySignalCount: 1,
      totalSignalCount: 3,
      phaseSignalCount: 5,
      lightPhaseHitCount: 2,
      remPhaseHitCount: 3,
    };
    const promotedEntries = [
      makeDreamingEntry("memory/2026-04-01.md", { totalSignalCount: 11, promotedAt: olderIso }),
      makeDreamingEntry("memory/notes/2026-04-04-0800.md", {
        totalSignalCount: 11,
        promotedAt: recentIso,
      }),
      makeDreamingEntry("memory/daily/2026-04-02-1015.md", {
        totalSignalCount: 14,
        promotedAt: recentIso,
      }),
    ];
    loadShortTermPromotionDreamingStats.mockImplementation(
      async ({ workspaceDir }: { workspaceDir: string }) =>
        workspaceDir === alpha
          ? makeDreamingStats({
              promotedTotal: 2,
              promotedToday: 1,
              promotedEntries: promotedEntries.slice(0, 2),
              lastPromotedAt: recentIso,
            })
          : makeDreamingStats({
              ...counts,
              promotedTotal: 1,
              promotedToday: 1,
              shortTermEntries: [recalledEntry],
              signalEntries: [recalledEntry],
              promotedEntries: promotedEntries.slice(2),
              lastPromotedAt: recentIso,
            }),
    );

    const { close } = useGemini(main);

    const cronList = vi.fn(async () => [
      {
        name: "Memory Dreaming Promotion",
        description: "[managed-by=memory-core.short-term-promotion] test",
        enabled: true,
        payload: {
          kind: "systemEvent",
          text: "__openclaw_memory_core_short_term_promotion_dream__",
        },
        state: { nextRunAtMs: now + 60_000 },
      },
    ]);
    try {
      expect(await memoryStatus({ cronList })).toMatchObject({
        agentId: "main",
        provider: "gemini",
        embedding: { ok: false, checked: false },
        dreaming: {
          enabled: true,
          timezone: "America/Los_Angeles",
          ...counts,
          promotedTotal: 3,
          promotedToday: 2,
          shortTermEntries: [recalledEntry],
          signalEntries: [recalledEntry],
          promotedEntries: expect.arrayContaining(promotedEntries),
          phases: {
            deep: {
              cron: "0 */4 * * *",
              recencyHalfLifeDays: 21,
              maxAgeDays: 30,
              managedCronPresent: true,
              nextRunAtMs: now + 60_000,
            },
          },
        },
      });
      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes dreaming status to the requested agent workspace", async () => {
    const { alpha } = workspaces();
    loadShortTermPromotionDreamingStats.mockImplementation(
      async ({ workspaceDir }: { workspaceDir: string }) =>
        makeDreamingStats({
          promotedTotal: 1,
          promotedEntries: [
            makeDreamingEntry("memory/2026-04-04.md", {
              snippet: workspaceDir === alpha ? "alpha agent memory" : "main agent memory",
              promotedAt: "2026-04-04T00:00:00.000Z",
            }),
          ],
          lastPromotedAt: "2026-04-04T00:00:00.000Z",
        }),
    );
    getRuntimeConfig.mockReturnValue(dreamingConfig({ entries: { alpha: { workspace: alpha } } }));

    useGemini(alpha);
    expect(await memoryStatus({ params: { agentId: "alpha" } })).toMatchObject({
      agentId: "alpha",
      dreaming: {
        shortTermCount: 0,
        promotedTotal: 1,
        promotedEntries: [{ snippet: "alpha agent memory" }],
      },
    });
  });

  it("falls back to the manager workspace when no configured dreaming workspaces resolve", async () => {
    const workspaceDir = tempDirs.make("doctor-memory-fallback-");
    resolveMemorySearchConfig.mockReturnValue(null);
    loadShortTermPromotionDreamingStats.mockResolvedValueOnce(
      makeDreamingStats({
        promotedTotal: 1,
        promotedEntries: [
          makeDreamingEntry("memory/2026-04-03.md", {
            endLine: 1,
            promotedAt: "2026-04-04T00:00:00.000Z",
          }),
        ],
        lastPromotedAt: "2026-04-04T00:00:00.000Z",
      }),
    );
    getRuntimeConfig.mockReturnValue(dreamingConfig());

    useGemini(workspaceDir);
    expect((await memoryStatus()).dreaming).toMatchObject({
      shortTermCount: 0,
      promotedTotal: 1,
      phases: { deep: { managedCronPresent: false } },
    });
  });

  it("merges workspace store errors when multiple workspace stores are unreadable", async () => {
    const { main, entries } = workspaces();
    getRuntimeConfig.mockReturnValue({
      memory: { search: { enabled: true } },
      ...dreamingConfig({
        defaults: { systemAgent: { agentId: "main" } },
        entries,
      }),
    });

    loadShortTermPromotionDreamingStats.mockRejectedValue(new Error("denied"));

    useGemini(main);
    expect((await memoryStatus()).dreaming).toMatchObject({
      shortTermCount: 0,
      promotedTotal: 0,
      storeError: "2 dreaming stores had read errors.",
    });
  });
});

describe("doctor.memory dream actions", () => {
  const repairedArtifacts = {
    changed: true,
    archiveDir: "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-00-00-000Z",
    archivedDreamsDiary: false,
    archivedSessionCorpus: true,
    archivedSessionIngestion: true,
    warnings: [],
  };
  it.each([
    [
      "resetGroundedShortTerm",
      removeGroundedShortTermCandidates,
      { removed: 3, storePath: "/tmp/openclaw/memory/.dreams/short-term-recall.json" },
      { removedShortTermEntries: 3 },
    ],
    [
      "repairDreamingArtifacts",
      repairDreamingArtifacts,
      { ...repairedArtifacts, archivedPaths: [] },
      repairedArtifacts,
    ],
    [
      "dedupeDreamDiary",
      dedupeDreamDiaryEntries,
      { dreamsPath: "/tmp/openclaw/DREAMS.md", removed: 2, kept: 7 },
      {
        path: "DREAMS.md",
        found: false,
        removedEntries: 2,
        dedupedEntries: 2,
        keptEntries: 7,
      },
    ],
    [
      "resetDreamDiary",
      removeBackfillDiaryEntries,
      { removed: 3 },
      { path: "DREAMS.md", found: true, removedEntries: 3 },
    ],
  ] as const)("dispatches %s to its workspace owner", async (action, handler, result, expected) => {
    const workspaceDir =
      action === "resetDreamDiary" ? tempDirs.make("doctor-dream-diary-reset-") : "/tmp/openclaw";
    if (action === "resetDreamDiary") {
      await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "# Dream Diary\n");
    }
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    handler.mockResolvedValue(result);
    const respond = vi.fn();
    await invokeDoctorMemory(`doctor.memory.${action}`, respond);
    expect(handler).toHaveBeenCalledWith({ workspaceDir });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        action: action === "resetDreamDiary" ? "reset" : action,
        ...expected,
      },
      undefined,
    );
  });
});

describe("doctor.memory.dreamDiary", () => {
  beforeEach(() => {
    getRuntimeConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentWorkspaceDir.mockReset().mockReturnValue("/tmp/openclaw");
    previewGroundedRemMarkdown.mockReset();
    writeBackfillDiaryEntries.mockReset();
    removeBackfillDiaryEntries.mockReset();
  });

  it.each([false, true])(
    "reads the Harness diary without following symlinks: symlink=%s",
    async (symlink) => {
      const workspaceDir = await diaryWorkspace();
      const { stat, readFile } = remoteDiary("current Harness diary", symlink);
      const payload = await memoryPayload("doctor.memory.dreamDiary");
      expect(getAgentWorkspaceAccess).toHaveBeenCalledWith(workspaceDir, "memoryFiles");
      expect(stat).toHaveBeenCalledWith(path.join(workspaceDir, "DREAMS.md"), false);
      if (symlink) {
        expect(stat).toHaveBeenCalledTimes(2);
        expect(readFile).not.toHaveBeenCalled();
        expectRecordFields(payload, { found: false });
      } else {
        expect(readFile).toHaveBeenCalledWith(path.join(workspaceDir, "DREAMS.md"));
        expectRecordFields(payload, {
          found: true,
          content: "current Harness diary",
          updatedAtMs: 1234,
        });
      }
    },
  );

  it("does not fall back to Gateway files when remote maintenance is unavailable", async () => {
    await diaryWorkspace();
    getAgentWorkspaceAccess.mockReturnValue({ memoryFiles: {} });
    const respond = vi.fn();
    await expect(invokeDoctorMemory("doctor.memory.dreamDiary", respond)).rejects.toThrow(
      "Remote Memory maintenance is unavailable",
    );
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([
    { filename: "DREAMS.md", agentId: "research-analyst", content: "## Research Dreams\n" },
    { filename: "dreams.md", agentId: undefined, content: "lowercase diary\n" },
    { filename: undefined, agentId: undefined, content: undefined },
  ])(
    "reads the local diary $filename for agent $agentId",
    async ({ filename, agentId, content }) => {
      getAgentWorkspaceAccess.mockReturnValue({});
      const workspaceDir = tempDirs.make("doctor-local-diary-");
      if (filename && content) {
        await fs.writeFile(path.join(workspaceDir, filename), content);
      }
      resolveAgentWorkspaceDir.mockImplementation((_cfg, requested) =>
        !agentId || requested === agentId ? workspaceDir : "/tmp/openclaw",
      );
      const payload = await memoryPayload("doctor.memory.dreamDiary", {
        params: agentId ? { agentId } : {},
      });
      if (agentId) {
        expect(resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.anything(), agentId);
      }
      expectRecordFields(payload, {
        agentId: agentId ?? "main",
        found: Boolean(filename),
        ...(content ? { content } : {}),
      });
      if (filename === "dreams.md") {
        expect(["DREAMS.md", "dreams.md"]).toContain(payload.path);
      } else {
        expect(payload.path).toBe("DREAMS.md");
      }
      if (filename) {
        expect(typeof payload.updatedAtMs).toBe("number");
      }
    },
  );

  it.each([
    { storage: "local", filename: "2026-02-19.md", body: "1. Bunji — partner" },
    {
      storage: "local",
      filename: "2026-02-19-vendor-pitch.md",
      body: "1. Vendor pitch — rejected",
    },
    { storage: "remote", filename: "2026-02-19.md", body: "1. Durable preference" },
    { storage: "empty", filename: undefined, body: undefined },
  ])("backfills $storage daily memory $filename", async ({ storage, filename, body }) => {
    const workspaceDir = tempDirs.make("doctor-dream-diary-backfill-");
    const sourcePath = filename ? path.join(workspaceDir, "memory", filename) : undefined;
    resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    let listDirectory: ReturnType<typeof remoteDiary>["listDirectory"] | undefined;
    if (storage === "remote") {
      ({ listDirectory } = remoteDiary("updated Harness diary"));
      listDirectory.mockResolvedValue([
        { name: "2026-02-19.md", isFile: true, isDirectory: false, isSymbolicLink: false },
        { name: "notes.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
      ]);
    } else if (sourcePath) {
      await fs.mkdir(path.join(workspaceDir, "memory"));
      await fs.writeFile(sourcePath, "source\n");
      await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "# Dream Diary\n");
    }
    if (sourcePath) {
      previewGroundedRemMarkdown.mockResolvedValue({
        scannedFiles: 1,
        files: [
          {
            path: storage === "remote" ? "memory/2026-02-19.md" : sourcePath,
            renderedMarkdown: `What Happened\n${body}\n`,
          },
        ],
      });
      writeBackfillDiaryEntries.mockResolvedValue({
        dreamsPath: path.join(workspaceDir, "DREAMS.md"),
        written: 1,
        replaced: storage === "remote" ? 0 : 1,
      });
    }
    const respond = vi.fn();
    await invokeDoctorMemory("doctor.memory.backfillDreamDiary", respond);
    if (!sourcePath) {
      expect(previewGroundedRemMarkdown).not.toHaveBeenCalled();
      expect(writeBackfillDiaryEntries).not.toHaveBeenCalled();
    } else {
      expect(previewGroundedRemMarkdown).toHaveBeenCalledWith({
        workspaceDir,
        inputPaths: [sourcePath],
      });
      if (storage === "remote") {
        expect(listDirectory).toHaveBeenCalledWith(path.join(workspaceDir, "memory"));
      }
      expect(mockCallArg(writeBackfillDiaryEntries)).toMatchObject({
        workspaceDir,
        entries: [
          {
            isoDay: "2026-02-19",
            sourcePath: storage === "remote" ? "memory/2026-02-19.md" : sourcePath,
            bodyLines: expect.arrayContaining(["What Happened", body]),
          },
        ],
      });
    }
    expectRecordFields(respondPayload(respond), {
      agentId: "main",
      action: "backfill",
      scannedFiles: sourcePath ? 1 : 0,
      written: sourcePath ? 1 : 0,
      replaced: storage === "local" ? 1 : 0,
    });
  });
});
