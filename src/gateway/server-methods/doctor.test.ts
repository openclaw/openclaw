import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { MemoryWorkspaceMaintenance } from "../../../packages/memory-host-sdk/src/host/workspace-files.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/config.js";
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
  expectRecordFields,
  respondPayload,
  mockCallArg,
  findRecordByField,
  makeDreamingStats,
  makeDreamingEntry,
  useMemoryManagerFixture,
  expectEmbeddingErrorResponse,
} from "./doctor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

  it.each([
    {
      method: "doctor.memory.status",
      params: {},
      selectionRequired: true,
      message: expect.stringContaining("agent"),
    },
    {
      method: "doctor.memory.status",
      params: { agentId: 42 },
      message: "agentId must be a string",
    },
    ...DOCTOR_MEMORY_TARGET_METHODS.map((method) => ({
      method,
      params: { agentId: "invented" },
      message: 'unknown agent id "invented"',
    })),
  ] satisfies Array<{
    method: Parameters<typeof invokeDoctorMemory>[0];
    params: Record<string, unknown>;
    selectionRequired?: boolean;
    message: unknown;
  }>)(
    "rejects invalid agent selection for $method: $params",
    async ({ method, params, ...scenario }) => {
      if ("selectionRequired" in scenario) {
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
        "selectionRequired" in scenario
          ? expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST, message: scenario.message })
          : errorShape(ErrorCodes.INVALID_REQUEST, scenario.message),
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

  it.each(["probe", "unprobed", "cached", "selected-plugin"] as const)(
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
      const respond = vi.fn();
      await invokeDoctorMemory("doctor.memory.status", respond, {
        params: mode === "probe" ? { probe: true } : {},
      });
      const managerInput = mockCallArg(getMemorySearchManager);
      expect(managerInput.cfg).toBeDefined();
      expectRecordFields(managerInput, { agentId: "main", purpose: "status" });
      const payload = respondPayload(respond);
      expectRecordFields(payload, { agentId: "main", provider: "gemini" });
      if (mode === "probe") {
        expect(payload.embedding).toEqual({ ok: true });
      } else {
        expect(probeEmbeddingAvailability).not.toHaveBeenCalled();
        expectRecordFields(
          payload.embedding,
          mode === "cached"
            ? { ok: true, checked: true, cached: true }
            : { ok: false, checked: false },
        );
      }
      const dreaming = expectRecordFields(payload.dreaming, {
        enabled: true,
        shortTermCount: 0,
        totalSignalCount: 0,
        phaseSignalCount: 0,
        promotedTotal: 0,
        promotedToday: 0,
        shortTermEntries: [],
        signalEntries: [],
        promotedEntries: [],
      });
      expect(dreaming.phases).toMatchObject({
        deep: {
          managedCronPresent: false,
          ...(mode === "selected-plugin" ? { cron: "0 */4 * * *" } : {}),
        },
      });
      expect(close).toHaveBeenCalled();
    },
  );

  it("orders dreaming entries deterministically when one timestamp is malformed", async () => {
    useMemoryManagerFixture({
      status: () => ({ provider: "gemini" }),
    });
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

    const respond = vi.fn();
    await invokeDoctorMemory("doctor.memory.status", respond, {});

    const dreaming = respondPayload(respond).dreaming as Record<string, unknown>;
    const entries = dreaming.shortTermEntries as Array<Record<string, unknown>>;
    // A NaN-returning comparator would leave the order undefined; with the fix
    // the malformed timestamp coerces to -Infinity so the valid recent entry
    // sorts first even though the malformed entry has more signals.
    expect(entries[0]).toMatchObject({ path: "memory/recent.md" });
    expect(entries[1]).toMatchObject({ path: "memory/malformed.md" });
  });

  it("returns llama.cpp runtime facts created by the deep embedding probe", async () => {
    let probed = false;
    const { close } = useMemoryManagerFixture({
      status: () => ({
        provider: "local",
        ...(probed
          ? {
              custom: {
                llamaCppRuntime: {
                  engine: "llama.cpp",
                  state: "ready",
                  backend: "cpu",
                  buildInfo: "b10357 (689e227db)",
                  model: { id: "embedding-model", path: "/models/embedding.gguf" },
                  capabilities: { vision: false, draft: false },
                  endpoints: {
                    health: "ready",
                    models: "ready",
                    props: "ready",
                    metrics: "ready",
                  },
                },
              },
            }
          : {}),
      }),
      probeEmbeddingAvailability: vi.fn(async () => {
        probed = true;
        return { ok: true };
      }),
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: { probe: true } });

    expect(respondPayload(respond).embeddingRuntime).toMatchObject({
      state: "ready",
      backend: "cpu",
      buildInfo: "b10357 (689e227db)",
      model: { id: "embedding-model", path: "/models/embedding.gguf" },
      capabilities: { vision: false, draft: false },
      endpoints: { health: "ready", metrics: "ready" },
    });
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
      const respond = vi.fn();
      await invokeDoctorMemory("doctor.memory.status", respond, { params: { probe: true } });
      expectEmbeddingErrorResponse(
        respond,
        mode === "missing" ? "memory search unavailable" : "gateway memory probe failed: timeout",
      );
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
    const workspaceRoot = tempDirs.make("doctor-memory-status-");
    const mainWorkspaceDir = path.join(workspaceRoot, "main");
    const alphaWorkspaceDir = path.join(workspaceRoot, "alpha");
    getRuntimeConfig.mockReturnValue({
      memory: {
        search: {
          enabled: true,
        },
      },

      agents: {
        defaults: {
          systemAgent: { agentId: "main" },
          userTimezone: "America/Los_Angeles",
        },
        list: [
          { id: "main", workspace: mainWorkspaceDir },
          { id: "alpha", workspace: alphaWorkspaceDir },
        ],
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                frequency: "0 */4 * * *",
                phases: {
                  deep: {
                    recencyHalfLifeDays: 21,
                    maxAgeDays: 30,
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig);
    resolveAgentWorkspaceDir.mockImplementation((cfg: OpenClawConfig, agentId: string) => {
      if (agentId === "alpha") {
        return alphaWorkspaceDir;
      }
      return mainWorkspaceDir;
    });
    loadShortTermPromotionDreamingStats.mockImplementation(
      async ({ workspaceDir }: { workspaceDir: string }) =>
        workspaceDir === alphaWorkspaceDir
          ? makeDreamingStats({
              shortTermCount: 0,
              promotedTotal: 2,
              promotedToday: 1,
              promotedEntries: [
                makeDreamingEntry("memory/2026-04-01.md", {
                  snippet: "Bunji lives in London.",
                  recallCount: 7,
                  dailyCount: 4,
                  totalSignalCount: 11,
                  promotedAt: olderIso,
                }),
                makeDreamingEntry("memory/notes/2026-04-04-0800.md", {
                  snippet: "Always book the covered valet option at Park & Greet BCN.",
                  recallCount: 8,
                  dailyCount: 3,
                  totalSignalCount: 11,
                  promotedAt: recentIso,
                }),
              ],
              lastPromotedAt: recentIso,
            })
          : makeDreamingStats({
              shortTermCount: 1,
              recallSignalCount: 2,
              dailySignalCount: 1,
              totalSignalCount: 3,
              phaseSignalCount: 5,
              lightPhaseHitCount: 2,
              remPhaseHitCount: 3,
              promotedTotal: 1,
              promotedToday: 1,
              shortTermEntries: [
                makeDreamingEntry("memory/2026-04-03-1503.md", {
                  snippet: "Emma prefers shorter, lower-pressure check-ins.",
                  recallCount: 2,
                  dailyCount: 1,
                  totalSignalCount: 3,
                  lightHits: 2,
                  remHits: 3,
                  phaseHitCount: 5,
                  lastRecalledAt: recentIso,
                }),
              ],
              signalEntries: [
                makeDreamingEntry("memory/2026-04-03-1503.md", {
                  snippet: "Emma prefers shorter, lower-pressure check-ins.",
                  recallCount: 2,
                  dailyCount: 1,
                  totalSignalCount: 3,
                  lightHits: 2,
                  remHits: 3,
                  phaseHitCount: 5,
                  lastRecalledAt: recentIso,
                }),
              ],
              promotedEntries: [
                makeDreamingEntry("memory/daily/2026-04-02-1015.md", {
                  snippet: "Use the Happy Together calendar for flights.",
                  recallCount: 9,
                  dailyCount: 5,
                  totalSignalCount: 14,
                  promotedAt: recentIso,
                }),
              ],
              lastPromotedAt: recentIso,
            }),
    );

    const { close } = useMemoryManagerFixture({
      status: () => ({ provider: "gemini", workspaceDir: mainWorkspaceDir }),
    });

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
    const respond = vi.fn();

    try {
      await invokeDoctorMemory("doctor.memory.status", respond, { cronList });
      const payload = respondPayload(respond);
      expectRecordFields(payload, {
        agentId: "main",
        provider: "gemini",
      });
      expectRecordFields(payload.embedding, { ok: false, checked: false });
      const dreaming = expectRecordFields(payload.dreaming, {
        enabled: true,
        timezone: "America/Los_Angeles",
        shortTermCount: 1,
        recallSignalCount: 2,
        dailySignalCount: 1,
        totalSignalCount: 3,
        phaseSignalCount: 5,
        lightPhaseHitCount: 2,
        remPhaseHitCount: 3,
        promotedTotal: 3,
        promotedToday: 2,
      });
      expectRecordFields((dreaming.shortTermEntries as unknown[])[0], {
        path: "memory/2026-04-03-1503.md",
        snippet: "Emma prefers shorter, lower-pressure check-ins.",
        totalSignalCount: 3,
        lightHits: 2,
        remHits: 3,
        phaseHitCount: 5,
      });
      expectRecordFields((dreaming.signalEntries as unknown[])[0], {
        path: "memory/2026-04-03-1503.md",
        totalSignalCount: 3,
      });
      expectRecordFields(
        findRecordByField(dreaming.promotedEntries, "path", "memory/notes/2026-04-04-0800.md"),
        {
          promotedAt: recentIso,
        },
      );
      expectRecordFields(
        findRecordByField(dreaming.promotedEntries, "path", "memory/daily/2026-04-02-1015.md"),
        {
          promotedAt: recentIso,
        },
      );
      expectRecordFields(
        findRecordByField(dreaming.promotedEntries, "path", "memory/2026-04-01.md"),
        {
          promotedAt: olderIso,
        },
      );
      const phases = expectRecordFields(dreaming.phases, {});
      expectRecordFields(phases.deep, {
        cron: "0 */4 * * *",
        recencyHalfLifeDays: 21,
        maxAgeDays: 30,
        managedCronPresent: true,
        nextRunAtMs: now + 60_000,
      });
      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes dreaming status to the requested agent workspace", async () => {
    const workspaceRoot = tempDirs.make("doctor-memory-selected-");
    const mainWorkspaceDir = path.join(workspaceRoot, "main");
    const alphaWorkspaceDir = path.join(workspaceRoot, "alpha");
    loadShortTermPromotionDreamingStats.mockImplementation(
      async ({ workspaceDir }: { workspaceDir: string }) =>
        makeDreamingStats({
          promotedTotal: 1,
          promotedEntries: [
            makeDreamingEntry("memory/2026-04-04.md", {
              snippet:
                workspaceDir === alphaWorkspaceDir ? "alpha agent memory" : "main agent memory",
              promotedAt: "2026-04-04T00:00:00.000Z",
            }),
          ],
          lastPromotedAt: "2026-04-04T00:00:00.000Z",
        }),
    );
    getRuntimeConfig.mockReturnValue({
      agents: {
        list: [{ id: "alpha", workspace: alphaWorkspaceDir }],
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {},
            },
          },
        },
      },
    } as OpenClawConfig);
    resolveAgentWorkspaceDir.mockImplementation((_cfg: OpenClawConfig, agentId: string) => {
      if (agentId === "alpha") {
        return alphaWorkspaceDir;
      }
      return mainWorkspaceDir;
    });

    useMemoryManagerFixture({
      status: () => ({ provider: "gemini", workspaceDir: alphaWorkspaceDir }),
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: { agentId: "alpha" } });
    const payload = respondPayload(respond);
    expectRecordFields(payload, {
      agentId: "alpha",
    });
    const dreaming = expectRecordFields(payload.dreaming, {
      shortTermCount: 0,
      promotedTotal: 1,
    });
    expectRecordFields((dreaming.promotedEntries as unknown[])[0], {
      snippet: "alpha agent memory",
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
    getRuntimeConfig.mockReturnValue({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {},
            },
          },
        },
      },
    } as OpenClawConfig);

    useMemoryManagerFixture({
      status: () => ({ provider: "gemini", workspaceDir }),
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond);
    const payload = respondPayload(respond);
    const dreaming = expectRecordFields(payload.dreaming, {
      shortTermCount: 0,
      promotedTotal: 1,
    });
    const phases = expectRecordFields(dreaming.phases, {});
    expectRecordFields(phases.deep, {
      managedCronPresent: false,
    });
  });

  it("merges workspace store errors when multiple workspace stores are unreadable", async () => {
    const workspaceRoot = tempDirs.make("doctor-memory-error-");
    const mainWorkspaceDir = path.join(workspaceRoot, "main");
    const alphaWorkspaceDir = path.join(workspaceRoot, "alpha");
    getRuntimeConfig.mockReturnValue({
      memory: {
        search: {
          enabled: true,
        },
      },

      agents: {
        defaults: { systemAgent: { agentId: "main" } },
        list: [
          { id: "main", workspace: mainWorkspaceDir },
          { id: "alpha", workspace: alphaWorkspaceDir },
        ],
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {},
            },
          },
        },
      },
    } as OpenClawConfig);
    resolveAgentWorkspaceDir.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
      agentId === "alpha" ? alphaWorkspaceDir : mainWorkspaceDir,
    );

    loadShortTermPromotionDreamingStats.mockRejectedValue(new Error("denied"));

    useMemoryManagerFixture({
      status: () => ({ provider: "gemini", workspaceDir: mainWorkspaceDir }),
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond);
    const payload = respondPayload(respond);
    expectRecordFields(payload.dreaming, {
      shortTermCount: 0,
      promotedTotal: 0,
      storeError: "2 dreaming stores had read errors.",
    });
  });
});

describe("doctor.memory dream actions", () => {
  it.each([
    {
      action: "resetGroundedShortTerm",
      handler: removeGroundedShortTermCandidates,
      result: { removed: 3, storePath: "/tmp/openclaw/memory/.dreams/short-term-recall.json" },
      expected: { removedShortTermEntries: 3 },
    },
    {
      action: "repairDreamingArtifacts",
      handler: repairDreamingArtifacts,
      result: {
        changed: true,
        archiveDir: "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-00-00-000Z",
        archivedDreamsDiary: false,
        archivedSessionCorpus: true,
        archivedSessionIngestion: true,
        archivedPaths: [],
        warnings: [],
      },
      expected: {
        changed: true,
        archiveDir: "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-00-00-000Z",
        archivedDreamsDiary: false,
        archivedSessionCorpus: true,
        archivedSessionIngestion: true,
        warnings: [],
      },
    },
    {
      action: "dedupeDreamDiary",
      handler: dedupeDreamDiaryEntries,
      result: { dreamsPath: "/tmp/openclaw/DREAMS.md", removed: 2, kept: 7 },
      expected: {
        path: "DREAMS.md",
        found: false,
        removedEntries: 2,
        dedupedEntries: 2,
        keptEntries: 7,
      },
    },
    {
      action: "resetDreamDiary",
      handler: removeBackfillDiaryEntries,
      result: { removed: 3 },
      expected: { path: "DREAMS.md", found: true, removedEntries: 3 },
    },
  ] as const)(
    "dispatches $action to its workspace owner",
    async ({ action, handler, result, expected }) => {
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
    },
  );
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
      const workspaceDir = tempDirs.make("doctor-remote-diary-");
      await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "stale Gateway diary");
      resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
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
        readFile.mockResolvedValue(Buffer.from("current Harness diary"));
      }
      const listDirectory = vi.fn<MemoryWorkspaceMaintenance["listDirectory"]>();
      getAgentWorkspaceAccess.mockReturnValue({
        memoryFiles: { maintenance: { stat, readFile, listDirectory } },
      });
      const respond = vi.fn();
      await invokeDoctorMemory("doctor.memory.dreamDiary", respond);
      expect(getAgentWorkspaceAccess).toHaveBeenCalledWith(workspaceDir, "memoryFiles");
      expect(stat).toHaveBeenCalledWith(path.join(workspaceDir, "DREAMS.md"), false);
      if (symlink) {
        expect(stat).toHaveBeenCalledTimes(2);
        expect(readFile).not.toHaveBeenCalled();
        expectRecordFields(respondPayload(respond), { found: false });
      } else {
        expect(readFile).toHaveBeenCalledWith(path.join(workspaceDir, "DREAMS.md"));
        expectRecordFields(respondPayload(respond), {
          found: true,
          content: "current Harness diary",
          updatedAtMs: 1234,
        });
      }
    },
  );

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

  it.each([
    {
      filename: "DREAMS.md",
      agentId: undefined,
      content: "## Dream Diary\n- staged durable memory\n",
    },
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
      const respond = vi.fn();
      await invokeDoctorMemory("doctor.memory.dreamDiary", respond, {
        params: agentId ? { agentId } : {},
      });
      if (agentId) {
        expect(resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.anything(), agentId);
      }
      const payload = respondPayload(respond);
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
    const listDirectory = vi.fn<MemoryWorkspaceMaintenance["listDirectory"]>();
    if (storage === "remote") {
      listDirectory.mockResolvedValue([
        { name: "2026-02-19.md", isFile: true, isDirectory: false, isSymbolicLink: false },
        { name: "notes.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
      ]);
      getAgentWorkspaceAccess.mockReturnValue({
        memoryFiles: {
          maintenance: {
            stat: vi.fn<MemoryWorkspaceMaintenance["stat"]>().mockResolvedValue({
              isFile: true,
              isDirectory: false,
              isSymbolicLink: false,
              size: 20,
              mtimeMs: 1234,
              mode: 0o600,
            }),
            readFile: vi
              .fn<MemoryWorkspaceMaintenance["readFile"]>()
              .mockResolvedValue(Buffer.from("updated Harness diary")),
            listDirectory,
          },
        },
      });
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
      const writeInput = mockCallArg(writeBackfillDiaryEntries);
      expect(writeInput.workspaceDir).toBe(workspaceDir);
      const entry = expectDefined(
        (writeInput.entries as Array<Record<string, unknown>>)[0],
        "backfill entry",
      );
      expectRecordFields(entry, {
        isoDay: "2026-02-19",
        sourcePath: storage === "remote" ? "memory/2026-02-19.md" : sourcePath,
      });
      expect(entry.bodyLines).toContain("What Happened");
      expect(entry.bodyLines).toContain(body);
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
