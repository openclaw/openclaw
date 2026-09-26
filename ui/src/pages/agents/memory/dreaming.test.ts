// Control UI tests cover dreaming behavior.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { i18n } from "../../../i18n/index.ts";
import type { TranslationMap } from "../../../i18n/lib/types.ts";
import { en } from "../../../i18n/locales/en.ts";
import type { RuntimeConfigCapability } from "../../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import {
  backfillDreamDiary,
  copyDreamingArchivePath,
  createDreamingState,
  dedupeDreamDiary,
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiOverview,
  repairDreamingArtifacts,
  resetGroundedShortTerm,
  resetDreamDiary,
  resolveConfiguredDreaming,
  updateDreamingEnabled,
  type DreamingState,
} from "./dreaming.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;
type DreamingConfigCapability = Pick<
  RuntimeConfigCapability,
  "lookupSchemaPath" | "patch" | "state"
>;

let restoreTranslations = () => {};

function asTranslationMap(value: string | TranslationMap | undefined): TranslationMap {
  return value && typeof value === "object" ? value : {};
}

beforeAll(() => {
  const dreaming = asTranslationMap(en.dreaming);
  i18n.registerTranslation("en", {
    ...en,
    dreaming: {
      ...dreaming,
      actions: {
        dedupeRemovedOneAndKept: "Removed {removed} duplicate dream entry and kept {kept}.",
        dedupeRemovedManyAndKept: "Removed {removed} duplicate dream entries and kept {kept}.",
        dedupeRemovedOne: "Removed {removed} duplicate dream entry.",
        dedupeRemovedMany: "Removed {removed} duplicate dream entries.",
        repairArchivedThreadCorpus: "archived session corpus",
        repairArchivedIngestionState: "archived ingestion state",
        repairArchivedDreamDiary: "archived dream diary",
        repairNoChanges: "Dream cache repair finished with no changes.",
        repairCompleteWithArchive: "Dream cache repair complete: {actions}. Archive: {archiveDir}",
        repairComplete: "Dream cache repair complete: {actions}.",
        backfillComplete: "Backfilled {count} dream diary entries.",
        resetDiaryComplete: "Removed {count} backfilled dream diary entries.",
        clearReplayedComplete: "Cleared {count} replayed short-term entries.",
        complete: "Dream diary action complete.",
        confirmRepairDescription:
          "This archives derived dream cache files and rebuilds them from clean inputs. Your dream diary stays untouched.",
        confirmDedupeDescription:
          "This rewrites DREAMS.md and removes only exact duplicate diary entries.",
        archivePathCopied: "Archive path copied.",
        archivePathCopyFailed: "Could not copy archive path.",
        updateFailed: "Could not update dreaming settings.",
        unsupportedPlugin:
          'Selected memory plugin "{pluginId}" does not support dreaming settings.',
        configHashMissing: "Config hash missing; refresh and retry.",
      },
    },
  });
  restoreTranslations = () => i18n.registerTranslation("en", en);
});

afterAll(() => {
  restoreTranslations();
});

function createState(): { state: DreamingState; request: ReturnType<typeof vi.fn<TestRequest>> } {
  const request = vi.fn<TestRequest>();
  const state: DreamingState = {
    ...createDreamingState({ selectedAgentId: "main" }),
    client: {
      request,
    } as unknown as DreamingState["client"],
    connected: true,
    configSnapshot: { hash: "hash-1" },
  };
  return { state, request };
}

function createMemoryWikiConfigSnapshot() {
  return {
    hash: "hash-1",
    config: {
      plugins: {
        entries: {
          "memory-wiki": {
            enabled: true,
          },
        },
      },
    },
  };
}

function createConfig(state: DreamingState): DreamingConfigCapability {
  const configState = {
    client: state.client,
    connected: state.connected,
    configSnapshot: state.configSnapshot,
  } as DreamingConfigCapability["state"];
  return {
    state: configState,
    lookupSchemaPath: vi.fn(async () => null),
    patch: vi.fn(async () => true),
  };
}

function getConfigPatchRawPayload(config: DreamingConfigCapability): Record<string, unknown> {
  const patch = vi.mocked(config.patch).mock.calls[0]?.[0]?.raw;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Expected config patch object");
  }
  return patch;
}

const wikiResources = [
  {
    label: "import insights",
    key: "wikiImportInsights",
    method: "wiki.importInsights",
    load: loadWikiImportInsights,
    payload: () => ({
      sourceType: "chatgpt" as const,
      totalItems: 0,
      totalClusters: 0,
      clusters: [],
    }),
  },
  {
    label: "overview",
    key: "wikiOverview",
    method: "wiki.overview",
    load: loadWikiOverview,
    payload: () => ({
      totalItems: 0,
      totalPages: 0,
      pageCounts: { source: 0, synthesis: 0, report: 0, entity: 0, concept: 0 },
      totalClaims: 0,
      totalQuestions: 0,
      totalContradictions: 0,
      clusters: [],
    }),
  },
] as const;

describe("dreaming controller", () => {
  it("retains the authoritative dreaming status from doctor.memory.status", async () => {
    const { state, request } = createState();
    const payload = { dreaming: { enabled: true, shortTermCount: 8 } };
    request.mockResolvedValue(payload);

    await loadDreamingStatus(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "main" });
    expect(state.dreamingStatus).toBe(payload.dreaming);
    expect(state.dreamingStatusLoading).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("does not request agent-scoped resources or actions without a selected agent", async () => {
    const { state, request } = createState();
    state.selectedAgentId = null;
    state.hello = gatewayHelloForMethods(
      ["wiki.importInsights", "wiki.overview", "doctor.memory.backfillDreamDiary"],
      ["operator.write"],
    );

    await Promise.all([
      loadDreamingStatus(state),
      loadDreamDiary(state),
      loadWikiImportInsights(state),
      loadWikiOverview(state),
    ]);

    await expect(backfillDreamDiary(state)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("ignores older same-agent status completions after switching back", async () => {
    const { state, request } = createState();
    const firstAgentA = createDeferred<unknown>();
    const agentB = createDeferred<unknown>();
    const secondAgentA = createDeferred<unknown>();
    request
      .mockImplementationOnce(async () => firstAgentA.promise)
      .mockImplementationOnce(async () => agentB.promise)
      .mockImplementationOnce(async () => secondAgentA.promise);

    state.selectedAgentId = "agent-a";
    const firstLoad = loadDreamingStatus(state);
    state.selectedAgentId = "agent-b";
    const secondLoad = loadDreamingStatus(state);
    state.selectedAgentId = "agent-a";
    const thirdLoad = loadDreamingStatus(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "agent-a" });
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "agent-b" });
    expect(request).toHaveBeenCalledTimes(3);

    secondAgentA.resolve({ dreaming: { enabled: true, shortTermCount: 3 } });
    await thirdLoad;

    expect(state.dreamingStatus?.shortTermCount).toBe(3);
    expect(state.dreamingStatusLoading).toBe(false);

    firstAgentA.resolve({ dreaming: { enabled: true, shortTermCount: 1 } });
    agentB.resolve({ dreaming: { enabled: true, shortTermCount: 2 } });
    await firstLoad;
    await secondLoad;

    expect(state.dreamingStatus?.shortTermCount).toBe(3);
    expect(state.dreamingStatusLoading).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it.each(wikiResources)(
    "keeps the newest $label response across an A-to-B-to-A agent switch",
    async ({ key, method, load, payload }) => {
      const { state, request } = createState();
      const firstAgentA = createDeferred<unknown>();
      const agentB = createDeferred<unknown>();
      const secondAgentA = createDeferred<unknown>();
      state.hello = gatewayHelloForMethods([method], []);
      request
        .mockImplementationOnce(async () => firstAgentA.promise)
        .mockImplementationOnce(async () => agentB.promise)
        .mockImplementationOnce(async () => secondAgentA.promise);

      state.selectedAgentId = "agent-a";
      const staleA = load(state);
      state.selectedAgentId = "agent-b";
      const staleB = load(state);
      state.selectedAgentId = "agent-a";
      const latest = load(state);
      const latestPayload = payload();

      secondAgentA.resolve(latestPayload);
      await latest;
      expect(state[key]).toBe(latestPayload);

      firstAgentA.resolve(payload());
      agentB.resolve(payload());
      await Promise.all([staleA, staleB]);

      expect(request).toHaveBeenCalledWith(method, { agentId: "agent-a" });
      expect(request).toHaveBeenCalledWith(method, { agentId: "agent-b" });
      expect(state[key]).toBe(latestPayload);
      expect(state.resourceRequests[key]).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(3);
    },
  );

  it.each(wikiResources)(
    "invalidates an in-flight $label request when its gateway capability disappears",
    async ({ key, method, load, payload }) => {
      const { state, request } = createState();
      const deferred = createDeferred<unknown>();
      state.hello = gatewayHelloForMethods([method], []);
      request.mockImplementationOnce(async () => deferred.promise);

      const stale = load(state);
      state.hello = { ...state.hello, features: { methods: [] } };
      await load(state);
      expect(state[key]).toBeNull();

      deferred.resolve(payload());
      await stale;

      expect(state[key]).toBeNull();
      expect(state.resourceRequests[key]).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("falls back to config gating for wiki import insights when methods are not advertised", async () => {
    const { state, request } = createState();
    state.configSnapshot = createMemoryWikiConfigSnapshot();
    request.mockResolvedValue({
      sourceType: "chatgpt",
      totalItems: 1,
      totalClusters: 1,
      clusters: [],
    });

    await loadWikiImportInsights(state);

    expect(request).toHaveBeenCalledWith("wiki.importInsights", { agentId: "main" });
    expect(state.wikiImportInsights?.totalItems).toBe(1);
    expect(state.wikiImportInsights?.totalClusters).toBe(1);
    expect(state.wikiImportInsightsError).toBeNull();
    expect(state.wikiImportInsightsLoading).toBe(false);
  });

  it("skips wiki import insights when memory-wiki is not enabled", async () => {
    const { state, request } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {},
      },
    };
    state.wikiImportInsights = {
      sourceType: "chatgpt",
      totalItems: 1,
      totalClusters: 1,
      truncated: false,
      clusters: [],
    };
    state.wikiImportInsightsError = "unknown method: wiki.importInsights";

    await loadWikiImportInsights(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.wikiImportInsights).toBeNull();
    expect(state.wikiImportInsightsError).toBeNull();
    expect(state.wikiImportInsightsLoading).toBe(false);
  });

  it("skips wiki import insights when the gateway does not advertise the method", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(["doctor.memory.status"], []);
    state.configSnapshot = createMemoryWikiConfigSnapshot();
    state.wikiImportInsights = {
      sourceType: "chatgpt",
      totalItems: 1,
      totalClusters: 1,
      truncated: false,
      clusters: [],
    };
    state.wikiImportInsightsError = "unknown method: wiki.importInsights";

    await loadWikiImportInsights(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.wikiImportInsights).toBeNull();
    expect(state.wikiImportInsightsError).toBeNull();
    expect(state.wikiImportInsightsLoading).toBe(false);
  });

  it("patches config to update global dreaming enablement", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(["config.patch"]);
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          slots: {
            memory: "memos-local-openclaw-plugin",
          },
          entries: {
            "memos-local-openclaw-plugin": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    };
    request.mockResolvedValue({ ok: true });
    const config = createConfig(state);

    const ok = await updateDreamingEnabled(state, config, false);

    expect(ok).toBe(true);
    expect(config.patch).toHaveBeenCalledWith({
      note: "Dreaming settings updated from the Dreaming tab.",
      raw: expect.any(Object),
      canDispatch: expect.any(Function),
    });
    expect(getConfigPatchRawPayload(config)).toEqual({
      plugins: {
        entries: {
          "memos-local-openclaw-plugin": {
            config: {
              dreaming: {
                enabled: false,
              },
            },
          },
        },
      },
    });
    expect(state.dreamingModeSaving).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("does not patch after the caller lifecycle expires during schema lookup", async () => {
    const { state } = createState();
    const config = createConfig(state);
    const lookup = createDeferred<unknown>();
    let canDispatch = true;
    vi.mocked(config.lookupSchemaPath).mockReturnValue(lookup.promise);

    const update = updateDreamingEnabled(state, config, false, () => canDispatch);
    await vi.waitFor(() => expect(config.lookupSchemaPath).toHaveBeenCalledOnce());
    canDispatch = false;
    lookup.resolve({
      schema: { type: "object", additionalProperties: true },
      children: [],
    });

    await expect(update).resolves.toBe(false);
    expect(config.patch).not.toHaveBeenCalled();
  });

  it("falls back to memory-core when selected memory slot is blank", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(["config.patch"]);
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          slots: {
            memory: "   ",
          },
        },
      },
    };
    request.mockResolvedValue({ ok: true });
    const config = createConfig(state);

    const ok = await updateDreamingEnabled(state, config, true);

    expect(ok).toBe(true);
    expect(getConfigPatchRawPayload(config)).toEqual({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
              },
            },
          },
        },
      },
    });
  });

  it("blocks dreaming patch when selected plugin config rejects unknown keys", async () => {
    const { state } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          slots: {
            memory: "memory-lancedb",
          },
        },
      },
    };
    const config = createConfig(state);
    vi.mocked(config.lookupSchemaPath).mockResolvedValue({
      path: "plugins.entries.memory-lancedb.config",
      schema: {
        type: "object",
        additionalProperties: false,
      },
      children: [
        { key: "retentionDays", path: "plugins.entries.memory-lancedb.config.retentionDays" },
      ],
    });

    const ok = await updateDreamingEnabled(state, config, true);

    expect(ok).toBe(false);
    expect(config.lookupSchemaPath).toHaveBeenCalledWith("plugins.entries.memory-lancedb.config");
    expect(config.patch).not.toHaveBeenCalled();
    expect(state.dreamingStatusError).toBe(
      'Selected memory plugin "memory-lancedb" does not support dreaming settings.',
    );
  });

  it("reads dreaming enabled state from the selected memory slot plugin", () => {
    expect(
      resolveConfiguredDreaming({
        plugins: {
          slots: {
            memory: "memos-local-openclaw-plugin",
          },
          entries: {
            "memos-local-openclaw-plugin": {
              config: {
                dreaming: {
                  enabled: true,
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
      }),
    ).toEqual({
      pluginId: "memos-local-openclaw-plugin",
      enabled: true,
      overridden: true,
      engineOff: false,
    });
  });

  it('falls back to memory-core config but stays operationally off when the slot is "none"', () => {
    expect(
      resolveConfiguredDreaming({
        plugins: {
          slots: {
            memory: "none",
          },
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      pluginId: "memory-core",
      enabled: false,
      overridden: true,
      engineOff: true,
    });
  });

  it("keeps the default enabled while the default engine is active", () => {
    expect(resolveConfiguredDreaming({ plugins: { slots: {} } })).toEqual({
      pluginId: "memory-core",
      enabled: true,
      overridden: false,
      engineOff: false,
    });
  });

  it("uses the runtime enabled default when config omits the override", () => {
    expect(resolveConfiguredDreaming(null)).toEqual({
      pluginId: "memory-core",
      enabled: true,
      overridden: false,
      engineOff: false,
    });
  });

  it("fails gracefully when config hash is missing", async () => {
    const { state } = createState();
    state.configSnapshot = {};
    const config = createConfig(state);

    const ok = await updateDreamingEnabled(state, config, true);

    expect(ok).toBe(false);
    expect(config.patch).not.toHaveBeenCalled();
    expect(config.lookupSchemaPath).not.toHaveBeenCalled();
    expect(state.dreamingStatusError).toBe("Config hash missing; refresh and retry.");
  });

  it("loads dream diary content", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      found: true,
      path: "DREAMS.md",
      content: "## Dream Diary\n- recurring glacier thoughts",
    });

    await loadDreamDiary(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "main" });
    expect(state.dreamDiaryPath).toBe("DREAMS.md");
    expect(state.dreamDiaryContent).toBe("## Dream Diary\n- recurring glacier thoughts");
    expect(state.dreamDiaryError).toBeNull();
  });

  it("ignores older same-agent diary completions after switching back", async () => {
    const { state, request } = createState();
    const firstAgentA = createDeferred<unknown>();
    const agentB = createDeferred<unknown>();
    const secondAgentA = createDeferred<unknown>();
    request
      .mockImplementationOnce(async () => firstAgentA.promise)
      .mockImplementationOnce(async () => agentB.promise)
      .mockImplementationOnce(async () => secondAgentA.promise);

    state.selectedAgentId = "agent-a";
    const firstLoad = loadDreamDiary(state);
    state.selectedAgentId = "agent-b";
    const secondLoad = loadDreamDiary(state);
    state.selectedAgentId = "agent-a";
    const thirdLoad = loadDreamDiary(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "agent-a" });
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "agent-b" });
    expect(request).toHaveBeenCalledTimes(3);

    secondAgentA.resolve({ found: true, path: "DREAMS.md", content: "new agent-a diary" });
    await thirdLoad;

    expect(state.dreamDiaryContent).toBe("new agent-a diary");
    expect(state.dreamDiaryLoading).toBe(false);

    firstAgentA.resolve({ found: true, path: "DREAMS.md", content: "old agent-a diary" });
    agentB.resolve({ found: true, path: "DREAMS.md", content: "agent-b diary" });
    await firstLoad;
    await secondLoad;

    expect(state.dreamDiaryContent).toBe("new agent-a diary");
    expect(state.dreamDiaryLoading).toBe(false);
    expect(state.dreamDiaryError).toBeNull();
  });

  it("handles missing dream diary without error", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      found: false,
      path: "DREAMS.md",
    });

    await loadDreamDiary(state);

    expect(state.dreamDiaryPath).toBe("DREAMS.md");
    expect(state.dreamDiaryContent).toBeNull();
    expect(state.dreamDiaryError).toBeNull();
  });

  it("records dream diary request errors", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("dream diary read failed"));

    await loadDreamDiary(state);

    expect(state.dreamDiaryError).toBe("dream diary read failed");
    expect(state.dreamDiaryLoading).toBe(false);
  });

  it("does not run a write action with read-only operator access", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(["doctor.memory.backfillDreamDiary"], ["operator.read"]);

    await expect(backfillDreamDiary(state)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("runs dream diary actions and reloads state for the selected agent", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(["doctor.memory.backfillDreamDiary"], ["operator.write"]);
    state.selectedAgentId = "fishing-bot";
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.backfillDreamDiary") {
        return { action: "backfill", written: 1 };
      }
      if (method === "doctor.memory.dreamDiary") {
        return { found: true, path: "DREAMS.md", content: "fish dreams" };
      }
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      return {};
    });

    const ok = await backfillDreamDiary(state);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("doctor.memory.backfillDreamDiary", {
      agentId: "fishing-bot",
    });
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", {
      agentId: "fishing-bot",
    });
    expect(request).toHaveBeenCalledWith("doctor.memory.status", {
      agentId: "fishing-bot",
    });
    expect(state.dreamDiaryContent).toBe("fish dreams");
    expect(state.dreamDiaryActionLoading).toBe(false);
  });

  it("resets and reloads dream diary state", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(["doctor.memory.resetDreamDiary"], ["operator.write"]);
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.resetDreamDiary") {
        return { action: "reset", removedEntries: 79 };
      }
      if (method === "doctor.memory.dreamDiary") {
        return { found: false, path: "DREAMS.md" };
      }
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      return {};
    });

    const ok = await resetDreamDiary(state);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("doctor.memory.resetDreamDiary", { agentId: "main" });
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "main" });
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "main" });
    expect(state.dreamDiaryContent).toBeNull();
    expect(state.dreamDiaryActionLoading).toBe(false);
  });

  it("clears grounded staged entries and reloads only dreaming status", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(
      ["doctor.memory.resetGroundedShortTerm"],
      ["operator.write"],
    );
    state.dreamDiaryContent = "keep existing diary";
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.resetGroundedShortTerm") {
        return { action: "resetGroundedShortTerm", removedShortTermEntries: 2 };
      }
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      return {};
    });

    const ok = await resetGroundedShortTerm(state);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("doctor.memory.resetGroundedShortTerm", {
      agentId: "main",
    });
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "main" });
    expect(request).not.toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "main" });
    expect(state.dreamDiaryContent).toBe("keep existing diary");
    expect(state.dreamDiaryActionLoading).toBe(false);
  });

  it("repairs dreaming artifacts and reloads only dreaming status", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(
      ["doctor.memory.repairDreamingArtifacts"],
      ["operator.write"],
    );
    state.dreamDiaryContent = "keep existing diary";
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.repairDreamingArtifacts") {
        return {
          action: "repairDreamingArtifacts",
          changed: true,
          archiveDir: "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
          archivedSessionCorpus: true,
          archivedSessionIngestion: true,
        };
      }
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      return {};
    });

    const ok = await repairDreamingArtifacts(state);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("doctor.memory.repairDreamingArtifacts", {
      agentId: "main",
    });
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "main" });
    expect(request).not.toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "main" });
    expect(state.dreamDiaryContent).toBe("keep existing diary");
    expect(state.dreamDiaryActionMessage).toEqual({
      kind: "success",
      text: "Dream cache repair complete: archived session corpus, archived ingestion state. Archive: /tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
    });
    expect(state.dreamDiaryActionArchivePath).toBe(
      "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
    );
    expect(state.dreamDiaryActionLoading).toBe(false);
  });

  it("dedupes dream diary entries and reloads diary plus status", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(["doctor.memory.dedupeDreamDiary"], ["operator.write"]);
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.dedupeDreamDiary") {
        return {
          action: "dedupeDreamDiary",
          removedEntries: 2,
          keptEntries: 5,
        };
      }
      if (method === "doctor.memory.dreamDiary") {
        return { found: true, path: "DREAMS.md", content: "deduped diary" };
      }
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      return {};
    });

    const ok = await dedupeDreamDiary(state);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("doctor.memory.dedupeDreamDiary", { agentId: "main" });
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "main" });
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "main" });
    expect(state.dreamDiaryContent).toBe("deduped diary");
    expect(state.dreamDiaryActionMessage).toEqual({
      kind: "success",
      text: "Removed 2 duplicate dream entries and kept 5.",
    });
    expect(state.dreamDiaryActionArchivePath).toBeNull();
    expect(state.dreamDiaryActionLoading).toBe(false);
  });

  it("copies the dreaming repair archive path", async () => {
    const { state } = createState();
    state.dreamDiaryActionArchivePath =
      "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z";
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);

    const ok = await copyDreamingArchivePath(state);

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith(
      "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
    );
    expect(state.dreamDiaryActionMessage).toEqual({
      kind: "success",
      text: "Archive path copied.",
    });
  });

  it("reports when the dreaming repair archive path cannot be copied", async () => {
    const { state } = createState();
    state.dreamDiaryActionArchivePath = "/tmp/openclaw/archive";
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    } as unknown as Navigator);

    const ok = await copyDreamingArchivePath(state);

    expect(ok).toBe(false);
    expect(state.dreamDiaryActionMessage).toEqual({
      kind: "error",
      text: "Could not copy archive path.",
    });
  });
});
