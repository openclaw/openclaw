/**
 * Tests for doctor gateway methods and repair command dispatch.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, vi } from "vitest";
import type { MemoryWorkspaceMaintenance } from "../../../packages/memory-host-sdk/src/host/workspace-files.js";
import type { OpenClawConfig } from "../../config/config.js";

const getRuntimeConfig = vi.hoisted(() => vi.fn(() => ({}) as OpenClawConfig));
const listAgentIds = vi.hoisted(() => vi.fn(() => ["main", "research-analyst", "alpha"]));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg: OpenClawConfig, _agentId: string) => "/tmp/openclaw"),
);
const resolveMemorySearchConfig = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, _agentId: string) => { enabled: boolean } | null>(() => ({
    enabled: true,
  })),
);
const getMemorySearchManager = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryCore = vi.hoisted(() => vi.fn());
const getAgentWorkspaceAccess = vi.hoisted(() =>
  vi.fn<
    (workspaceDir: string) =>
      | {
          memoryFiles?: {
            maintenance?: Pick<MemoryWorkspaceMaintenance, "stat" | "readFile" | "listDirectory">;
          };
        }
      | undefined
  >(),
);

vi.mock("../../agents/workspace-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/workspace-access.js")>()),
  getAgentWorkspaceAccess,
}));

beforeEach(() => {
  getAgentWorkspaceAccess.mockReset();
});

const previewGroundedRemMarkdown = vi.hoisted(() => vi.fn());
const dedupeDreamDiaryEntries = vi.hoisted(() => vi.fn());
const writeBackfillDiaryEntries = vi.hoisted(() => vi.fn());
const removeBackfillDiaryEntries = vi.hoisted(() => vi.fn());
const removeGroundedShortTermCandidates = vi.hoisted(() => vi.fn());
const repairDreamingArtifacts = vi.hoisted(() => vi.fn());
const loadShortTermPromotionDreamingStats = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds,
  listAgentEntries: (cfg: OpenClawConfig) =>
    cfg.agents?.entries
      ? Object.entries(cfg.agents.entries).map(([id, entry]) => {
          const copy = structuredClone(entry) as Record<string, unknown>;
          copy.id = id;
          return copy;
        })
      : cfg.agents?.list
        ? cfg.agents.list
        : [{ id: "main", default: true }],
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
}));

vi.mock("../../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

vi.mock("../../plugins/memory-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/memory-runtime.js")>()),
  getActiveMemorySearchManagerCore: getMemorySearchManager,
}));

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore,
}));

import { createDoctorHandlers } from "./doctor.js";

const doctorHandlers = createDoctorHandlers({
  dedupeDreamDiaryEntries,
  loadShortTermPromotionDreamingStats,
  previewGroundedRemMarkdown,
  writeBackfillDiaryEntries,
  removeBackfillDiaryEntries,
  removeGroundedShortTermCandidates,
  repairDreamingArtifacts,
});

const makeRuntimeContext = () => ({ getRuntimeConfig: () => getRuntimeConfig() });

const DOCTOR_MEMORY_TARGET_METHODS = [
  "doctor.memory.status",
  "doctor.memory.dreamDiary",
  "doctor.memory.backfillDreamDiary",
  "doctor.memory.resetDreamDiary",
  "doctor.memory.resetGroundedShortTerm",
  "doctor.memory.repairDreamingArtifacts",
  "doctor.memory.dedupeDreamDiary",
] as const;

type DoctorMemoryMethod = (typeof DOCTOR_MEMORY_TARGET_METHODS)[number];

const invokeDoctorMemory = async (
  method: DoctorMemoryMethod,
  respond: ReturnType<typeof vi.fn>,
  options: {
    params?: Record<string, unknown>;
    cronList?: ReturnType<typeof vi.fn>;
    includeCron?: boolean;
  } = {},
) => {
  const cronList = options.cronList ?? vi.fn(async () => []);
  const context =
    method === "doctor.memory.status" || options.includeCron
      ? { ...makeRuntimeContext(), cron: { list: cronList } }
      : makeRuntimeContext();
  await expectDefined(
    doctorHandlers[method],
    `doctorHandlers["${method}"] test invariant`,
  )({
    req: {} as never,
    params: (options.params ?? {}) as never,
    respond: respond as never,
    context: context as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function respondPayload(respond: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const call = respond.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected respond call ${callIndex}`);
  }
  expect(call[0]).toBe(true);
  expect(call[2]).toBeUndefined();
  return call[1] as Record<string, unknown>;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0] as Record<string, unknown>;
}

function findRecordByField(items: unknown, key: string, value: unknown) {
  expect(Array.isArray(items)).toBe(true);
  return (items as Array<Record<string, unknown>>).find((item) => item[key] === value);
}

function makeDreamingStats(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shortTermCount: 0,
    recallSignalCount: 0,
    dailySignalCount: 0,
    groundedSignalCount: 0,
    totalSignalCount: 0,
    phaseSignalCount: 0,
    lightPhaseHitCount: 0,
    remPhaseHitCount: 0,
    promotedTotal: 0,
    promotedToday: 0,
    storePath: "plugin-state:memory-core/short-term-recall/test",
    phaseSignalPath: "plugin-state:memory-core/short-term-phase-signals/test",
    shortTermEntries: [],
    signalEntries: [],
    promotedEntries: [],
    ...overrides,
  };
}

type DreamingEntryFixture = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalSignalCount: number;
  lightHits: number;
  remHits: number;
  phaseHitCount: number;
  promotedAt?: string;
  lastRecalledAt?: string;
};

function makeDreamingEntry(
  entryPath: string,
  overrides: Partial<DreamingEntryFixture> = {},
): DreamingEntryFixture {
  return {
    key: `memory:${entryPath}:1:2`,
    path: entryPath,
    startLine: 1,
    endLine: 2,
    snippet: entryPath,
    recallCount: 0,
    dailyCount: 0,
    groundedCount: 0,
    totalSignalCount: 0,
    lightHits: 0,
    remHits: 0,
    phaseHitCount: 0,
    ...overrides,
  };
}

type MemoryManagerFixtureOptions = {
  status: () => Record<string, unknown>;
  probeEmbeddingAvailability?: ReturnType<typeof vi.fn>;
  getCachedEmbeddingAvailability?: ReturnType<typeof vi.fn>;
};

function useMemoryManagerFixture(options: MemoryManagerFixtureOptions) {
  const close = vi.fn().mockResolvedValue(undefined);
  const probeEmbeddingAvailability =
    options.probeEmbeddingAvailability ?? vi.fn().mockResolvedValue({ ok: true });
  getMemorySearchManager.mockResolvedValue({
    manager: {
      status: options.status,
      probeEmbeddingAvailability,
      ...(options.getCachedEmbeddingAvailability
        ? { getCachedEmbeddingAvailability: options.getCachedEmbeddingAvailability }
        : {}),
      close,
    },
  });
  return { close, probeEmbeddingAvailability };
}

const expectEmbeddingErrorResponse = (respond: ReturnType<typeof vi.fn>, error: string) => {
  const payload = respondPayload(respond);
  expectRecordFields(payload, {
    agentId: "main",
    embedding: {
      ok: false,
      error,
    },
  });
};

export {
  getRuntimeConfig,
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  getMemorySearchManager,
  loadPluginManifestRegistryCore,
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
};
