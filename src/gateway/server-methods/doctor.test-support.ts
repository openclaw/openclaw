import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, vi } from "vitest";
import type { MemoryWorkspaceMaintenance } from "../../../packages/memory-host-sdk/src/host/workspace-files.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ShortTermDreamingStatsEntry } from "../../memory-host-sdk/dreaming.js";

type Mock = ReturnType<typeof vi.fn>;
type Maintenance = Pick<MemoryWorkspaceMaintenance, "stat" | "readFile" | "listDirectory">;

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
const getActiveMemoryProviderCore = vi.hoisted(() => vi.fn());
const resolveActiveMemoryBackendConfig = vi.hoisted(() =>
  vi.fn<() => { backend: "builtin" } | { backend: "provider-runtime"; providerId: string }>(() => ({
    backend: "builtin",
  })),
);
const captureGatewayOperatorRunAuthority = vi.hoisted(() => vi.fn());
const getAgentWorkspaceAccess = vi.hoisted(() =>
  vi.fn<(workspaceDir: string) => { memoryFiles?: { maintenance?: Maintenance } } | undefined>(),
);

vi.mock("../../agents/workspace-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/workspace-access.js")>()),
  getAgentWorkspaceAccess,
}));

beforeEach(() => {
  getAgentWorkspaceAccess.mockReset();
  resolveActiveMemoryBackendConfig.mockReset().mockReturnValue({ backend: "builtin" });
  getActiveMemoryProviderCore.mockReset();
  captureGatewayOperatorRunAuthority.mockReset().mockResolvedValue({
    authority: { scopes: ["operator.read"], assertCurrent: vi.fn() },
    release: vi.fn(),
  });
});

const previewGroundedRemMarkdown = vi.hoisted(() => vi.fn());
const dedupeDreamDiaryEntries = vi.hoisted(() => vi.fn());
const writeBackfillDiaryEntries = vi.hoisted(() => vi.fn());
const removeBackfillDiaryEntries = vi.hoisted(() => vi.fn());
const removeGroundedShortTermCandidates = vi.hoisted(() => vi.fn());
const repairDreamingArtifacts = vi.hoisted(() => vi.fn());
const loadShortTermPromotionDreamingStats = vi.hoisted(() => vi.fn());

export {
  getRuntimeConfig,
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  getMemorySearchManager,
  getActiveMemoryProviderCore,
  resolveActiveMemoryBackendConfig,
  getAgentWorkspaceAccess,
  previewGroundedRemMarkdown,
  dedupeDreamDiaryEntries,
  writeBackfillDiaryEntries,
  removeBackfillDiaryEntries,
  removeGroundedShortTermCandidates,
  repairDreamingArtifacts,
  loadShortTermPromotionDreamingStats,
};

// mock-isolation: Doctor fixtures use synthetic config, never the operator's config.
vi.mock("../../config/config.js", () => ({ getRuntimeConfig }));

// mock-isolation: Agent IDs and workspaces belong to this fixture's synthetic inventory.
vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds,
  listAgentEntries: (cfg: OpenClawConfig) =>
    cfg.agents?.entries
      ? Object.entries(cfg.agents.entries).map(([id, entry]) =>
          Object.assign(structuredClone(entry), { id }),
        )
      : [{ id: "main" }],
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
}));

// mock-isolation: Memory configuration is supplied by each fixture without live initialization.
vi.mock("../../agents/memory-search.js", () => ({ resolveMemorySearchConfig }));

vi.mock("../../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManagerCore: getMemorySearchManager,
  getActiveMemoryProviderCore,
  resolveActiveMemoryBackendConfig,
}));

// mock-isolation: Exercise fixture-owned authority without a running Gateway session.
vi.mock("../operator-run-authority.js", () => ({ captureGatewayOperatorRunAuthority }));

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

export const DOCTOR_MEMORY_TARGET_METHODS = [
  "doctor.memory.status",
  "doctor.memory.dreamDiary",
  "doctor.memory.backfillDreamDiary",
  "doctor.memory.resetDreamDiary",
  "doctor.memory.resetGroundedShortTerm",
  "doctor.memory.repairDreamingArtifacts",
  "doctor.memory.dedupeDreamDiary",
] as const;

type DoctorMemoryMethod = (typeof DOCTOR_MEMORY_TARGET_METHODS)[number];

export const invokeDoctorMemory = async (
  method: DoctorMemoryMethod,
  respond: Mock,
  options: {
    params?: Record<string, unknown>;
    cronList?: Mock;
    includeCron?: boolean;
  } = {},
) => {
  const context = {
    getRuntimeConfig: () => getRuntimeConfig(),
    ...(method === "doctor.memory.status" || options.includeCron
      ? { cron: { list: options.cronList ?? vi.fn(async () => []) } }
      : {}),
  };
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

export function respondPayload(respond: Mock, callIndex = 0): Record<string, unknown> {
  const call = expectDefined(respond.mock.calls[callIndex], `Expected respond call ${callIndex}`);
  expect(call[0]).toBe(true);
  expect(call[2]).toBeUndefined();
  return call[1] as Record<string, unknown>;
}

export function makeDreamingStats(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

export function makeDreamingEntry(
  entryPath: string,
  overrides: Partial<ShortTermDreamingStatsEntry> = {},
): ShortTermDreamingStatsEntry {
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
  probeEmbeddingAvailability?: Mock;
  getCachedEmbeddingAvailability?: Mock;
};

export function useMemoryManagerFixture(options: MemoryManagerFixtureOptions) {
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
