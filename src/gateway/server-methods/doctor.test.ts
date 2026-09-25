import fs from "node:fs/promises";
import os from "node:os";
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

  it("returns gateway embedding probe status for the default agent", async () => {
    const { close } = useMemoryManagerFixture({
      status: () => ({ provider: "gemini" }),
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: { probe: true } });

    const managerInput = mockCallArg(getMemorySearchManager);
    if (managerInput.cfg === undefined) {
      throw new Error("Expected memory search manager config");
    }
    expectRecordFields(managerInput, {
      agentId: "main",
      purpose: "status",
    });
    const payload = respondPayload(respond);
    expectRecordFields(payload, {
      agentId: "main",
      provider: "gemini",
      embedding: { ok: true },
    });
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
    const phases = expectRecordFields(dreaming.phases, {});
    expectRecordFields(phases.deep, {
      managedCronPresent: false,
    });
    expect(close).toHaveBeenCalled();
  });

  it("returns gateway embedding probe status for the requested agent", async () => {
    useMemoryManagerFixture({
      status: () => ({ provider: "gemini", workspaceDir: "/tmp/research-workspace" }),
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, {
      params: { agentId: "research-analyst", probe: true },
    });

    expectRecordFields(mockCallArg(getMemorySearchManager), {
      agentId: "research-analyst",
      purpose: "status",
    });
    const payload = respondPayload(respond);
    expectRecordFields(payload, {
      agentId: "research-analyst",
      provider: "gemini",
      embedding: { ok: true },
    });
  });

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

  it("does not live-probe embedding readiness by default", async () => {
    const { close, probeEmbeddingAvailability } = useMemoryManagerFixture({
      status: () => ({ provider: "gemini" }),
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond);

    expect(probeEmbeddingAvailability).not.toHaveBeenCalled();
    const payload = respondPayload(respond);
    expectRecordFields(payload.embedding, { ok: false, checked: false });
    expect(close).toHaveBeenCalled();
  });

  it("returns cached embedding readiness without a live probe", async () => {
    const { close, probeEmbeddingAvailability } = useMemoryManagerFixture({
      status: () => ({ provider: "gemini" }),
      probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: false }),
      getCachedEmbeddingAvailability: vi.fn(() => ({
        ok: true,
        checked: true,
        cached: true,
        checkedAtMs: 123,
        cacheExpiresAtMs: 456,
      })),
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond);

    expect(probeEmbeddingAvailability).not.toHaveBeenCalled();
    const payload = respondPayload(respond);
    expectRecordFields(payload.embedding, { ok: true, checked: true, cached: true });
    expect(close).toHaveBeenCalled();
  });

  it("returns unavailable when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValue({
      manager: null,
      error: "memory search unavailable",
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: { probe: true } });

    expectEmbeddingErrorResponse(respond, "memory search unavailable");
  });

  it("returns probe failure when manager probe throws", async () => {
    const { close } = useMemoryManagerFixture({
      status: () => ({ provider: "openai" }),
      probeEmbeddingAvailability: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond, { params: { probe: true } });

    expectEmbeddingErrorResponse(respond, "gateway memory probe failed: timeout");
    expect(close).toHaveBeenCalled();
  });

  it("includes dreaming counts and managed cron status when workspace data is available", async () => {
    const now = Date.parse("2026-04-05T00:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const recentIso = "2026-04-04T23:45:00.000Z";
    const olderIso = "2026-04-02T10:00:00.000Z";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-status-"));
    const mainWorkspaceDir = path.join(workspaceRoot, "main");
    const alphaWorkspaceDir = path.join(workspaceRoot, "alpha");
    const mainStorePath = path.join(
      mainWorkspaceDir,
      "memory",
      ".dreams",
      "short-term-recall.json",
    );
    const alphaStorePath = path.join(
      alphaWorkspaceDir,
      "memory",
      ".dreams",
      "short-term-recall.json",
    );
    const mainPhaseSignalPath = path.join(
      mainWorkspaceDir,
      "memory",
      ".dreams",
      "phase-signals.json",
    );
    const alphaPhaseSignalPath = path.join(
      alphaWorkspaceDir,
      "memory",
      ".dreams",
      "phase-signals.json",
    );
    await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
    await fs.mkdir(path.dirname(alphaStorePath), { recursive: true });
    await fs.writeFile(
      mainStorePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: recentIso,
          entries: {
            "memory:memory/2026-04-03-1503.md:1:2": {
              path: "memory/2026-04-03-1503.md",
              startLine: 1,
              endLine: 2,
              snippet: "Emma prefers shorter, lower-pressure check-ins.",
              source: "memory",
              recallCount: 2,
              dailyCount: 1,
              lastRecalledAt: recentIso,
              promotedAt: undefined,
            },
            "memory:memory/daily/2026-04-02-1015.md:1:2": {
              path: "memory/daily/2026-04-02-1015.md",
              startLine: 1,
              endLine: 2,
              snippet: "Use the Happy Together calendar for flights.",
              source: "memory",
              recallCount: 9,
              dailyCount: 5,
              promotedAt: recentIso,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      alphaStorePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: recentIso,
          entries: {
            "memory:memory/2026-04-01.md:1:2": {
              path: "memory/2026-04-01.md",
              startLine: 1,
              endLine: 2,
              snippet: "Bunji lives in London.",
              source: "memory",
              recallCount: 7,
              dailyCount: 4,
              promotedAt: olderIso,
            },
            "memory:memory/notes/2026-04-04-0800.md:1:2": {
              path: "memory/notes/2026-04-04-0800.md",
              startLine: 1,
              endLine: 2,
              snippet: "Always book the covered valet option at Park & Greet BCN.",
              source: "memory",
              recallCount: 8,
              dailyCount: 3,
              promotedAt: recentIso,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      mainPhaseSignalPath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: recentIso,
          entries: {
            "memory:memory/2026-04-03-1503.md:1:2": {
              lightHits: 2,
              remHits: 3,
            },
            "memory:memory/daily/2026-04-02-1015.md:1:2": {
              lightHits: 9,
              remHits: 9,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      alphaPhaseSignalPath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: recentIso,
          entries: {
            "memory:memory/2026-04-01.md:1:2": {
              lightHits: 5,
              remHits: 5,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

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
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("scopes dreaming status to the requested agent workspace", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-selected-"));
    const mainWorkspaceDir = path.join(workspaceRoot, "main");
    const alphaWorkspaceDir = path.join(workspaceRoot, "alpha");
    const writeStore = async (workspaceDir: string, snippet: string) => {
      const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      const store = {
        version: 1,
        updatedAt: "2026-04-04T00:00:00.000Z",
        entries: {
          "memory:memory/2026-04-04.md:1:2": {
            path: "memory/2026-04-04.md",
            startLine: 1,
            endLine: 2,
            snippet,
            source: "memory",
            promotedAt: "2026-04-04T00:00:00.000Z",
          },
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2) + "\n", "utf-8");
    };
    await writeStore(mainWorkspaceDir, "main agent memory");
    await writeStore(alphaWorkspaceDir, "alpha agent memory");
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

    try {
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
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the manager workspace when no configured dreaming workspaces resolve", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-fallback-"));
    const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-04-04T00:00:00.000Z",
          entries: {
            "memory:memory/2026-04-03.md:1:2": {
              path: "memory/2026-04-03.md",
              source: "memory",
              promotedAt: "2026-04-04T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
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

    try {
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
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reads dreaming config from the selected memory slot plugin", async () => {
    getRuntimeConfig.mockReturnValue({
      plugins: {
        slots: {
          memory: "memos-local-openclaw-plugin",
        },
        entries: {
          "memos-local-openclaw-plugin": {
            config: {
              dreaming: {
                enabled: true,
                frequency: "0 */4 * * *",
              },
            },
          },
          "memory-core": {
            config: {
              dreaming: {
                enabled: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    const { close } = useMemoryManagerFixture({
      status: () => ({ provider: "gemini" }),
    });
    const respond = vi.fn();

    await invokeDoctorMemory("doctor.memory.status", respond);

    const payload = respondPayload(respond);
    const dreaming = expectRecordFields(payload.dreaming, {
      enabled: true,
    });
    const phases = expectRecordFields(dreaming.phases, {});
    expectRecordFields(phases.deep, {
      cron: "0 */4 * * *",
    });
    expect(close).toHaveBeenCalled();
  });

  it("merges workspace store errors when multiple workspace stores are unreadable", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-memory-error-"));
    const mainWorkspaceDir = path.join(workspaceRoot, "main");
    const alphaWorkspaceDir = path.join(workspaceRoot, "alpha");
    const alphaStorePath = path.join(
      alphaWorkspaceDir,
      "memory",
      ".dreams",
      "short-term-recall.json",
    );
    await fs.mkdir(path.dirname(alphaStorePath), { recursive: true });
    await fs.writeFile(
      alphaStorePath,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-04-04T00:00:00.000Z",
          entries: {},
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.mkdir(path.join(mainWorkspaceDir, "memory", ".dreams"), { recursive: true });

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

    try {
      await invokeDoctorMemory("doctor.memory.status", respond);
      const payload = respondPayload(respond);
      expectRecordFields(payload.dreaming, {
        shortTermCount: 0,
        promotedTotal: 0,
        storeError: "2 dreaming stores had read errors.",
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
