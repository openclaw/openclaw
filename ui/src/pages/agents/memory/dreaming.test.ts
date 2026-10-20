// Control UI tests cover dreaming behavior.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { i18n } from "../../../i18n/index.ts";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { en } from "../../../i18n/locales/en.ts";
import type { RuntimeConfigCapability } from "../../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import {
  copyDreamingArchivePath,
  createDreamingState,
  loadDreamingResource,
  runDreamDiaryAction,
  resolveConfiguredDreaming,
  updateDreamingEnabled,
  type DreamingState,
  type DreamDiaryActionMethod,
} from "./dreaming.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;
type DreamingConfigCapability = Pick<
  RuntimeConfigCapability,
  "lookupSchemaPath" | "patch" | "state"
>;

beforeAll(() => {
  registerDreamingEnglish();
  i18n.registerTranslation("en", en);
});
afterAll(() => i18n.registerTranslation("en", en));

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

function pluginConfig(pluginId: string, entry: Record<string, unknown>, memory = pluginId) {
  return { plugins: { slots: { memory }, entries: { [pluginId]: entry } } };
}

function createActionState(
  method: DreamDiaryActionMethod,
  payload: unknown,
  diary?: { found: boolean; path: string; content?: string },
) {
  const result = createState();
  result.state.hello = gatewayHelloForMethods([method], ["operator.write"]);
  result.request.mockImplementation(async (calledMethod) => {
    if (calledMethod === method) {
      return payload;
    }
    if (calledMethod === "doctor.memory.dreamDiary" && diary) {
      return diary;
    }
    if (calledMethod === "doctor.memory.status") {
      return { dreaming: null };
    }
    return {};
  });
  return result;
}

async function expectActionReload(
  state: DreamingState,
  request: ReturnType<typeof vi.fn<TestRequest>>,
  method: DreamDiaryActionMethod,
  content: string | null,
  reloadDiary = true,
) {
  const args = { agentId: state.selectedAgentId };
  await expect(runDreamDiaryAction(state, method)).resolves.toBe(true);
  expect(request).toHaveBeenCalledWith(method, args);
  expect(request).toHaveBeenCalledWith("doctor.memory.status", args);
  const diaryRequest = expect(request);
  if (reloadDiary) {
    diaryRequest.toHaveBeenCalledWith("doctor.memory.dreamDiary", args);
  } else {
    diaryRequest.not.toHaveBeenCalledWith("doctor.memory.dreamDiary", args);
  }
  expect(state).toMatchObject({ dreamDiaryContent: content, dreamDiaryActionLoading: false });
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

describe("dreaming controller", () => {
  it("retains the authoritative dreaming status from doctor.memory.status", async () => {
    const { state, request } = createState();
    const payload = { dreaming: { enabled: true, shortTermCount: 8 } };
    request.mockResolvedValue(payload);

    await loadDreamingResource(state, "dreamingStatus");

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
      loadDreamingResource(state, "dreamingStatus"),
      loadDreamingResource(state, "dreamDiary"),
      loadDreamingResource(state, "wikiImportInsights"),
      loadDreamingResource(state, "wikiOverview"),
    ]);

    await expect(runDreamDiaryAction(state, "doctor.memory.backfillDreamDiary")).resolves.toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("deduplicates status loads while the selected agent request is pending", async () => {
    const { state, request } = createState();
    const pending = createDeferred<unknown>();
    request.mockReturnValue(pending.promise);
    const firstLoad = loadDreamingResource(state, "dreamingStatus");
    await loadDreamingResource(state, "dreamingStatus");
    expect(request).toHaveBeenCalledExactlyOnceWith("doctor.memory.status", { agentId: "main" });
    expect(state.dreamingStatusLoading).toBe(true);

    pending.resolve({ dreaming: { enabled: true, shortTermCount: 3 } });
    await firstLoad;
    expect(state.dreamingStatus?.shortTermCount).toBe(3);
    expect(state.dreamingStatusLoading).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("falls back to config gating for wiki import insights when methods are not advertised", async () => {
    const { state, request } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: { plugins: { entries: { "memory-wiki": { enabled: true } } } },
    };
    request.mockResolvedValue({
      sourceType: "chatgpt",
      totalItems: 1,
      totalClusters: 1,
      clusters: [],
    });

    await loadDreamingResource(state, "wikiImportInsights");

    expect(request).toHaveBeenCalledWith("wiki.importInsights", { agentId: "main" });
    expect(state).toMatchObject({
      wikiImportInsights: { totalItems: 1, totalClusters: 1 },
      wikiImportInsightsError: null,
      wikiImportInsightsLoading: false,
    });
  });

  it("skips wiki import insights when memory-wiki is not enabled", async () => {
    const { state, request } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: { plugins: {} },
    };
    state.wikiImportInsights = {
      sourceType: "chatgpt",
      totalItems: 1,
      totalClusters: 1,
      truncated: false,
      clusters: [],
    };
    state.wikiImportInsightsError = "unknown method: wiki.importInsights";

    await loadDreamingResource(state, "wikiImportInsights");

    expect(request).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      wikiImportInsights: null,
      wikiImportInsightsError: null,
      wikiImportInsightsLoading: false,
    });
  });

  it("skips wiki import insights when the gateway does not advertise the method", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(["doctor.memory.status"], []);
    state.configSnapshot = {
      hash: "hash-1",
      config: { plugins: { entries: { "memory-wiki": { enabled: true } } } },
    };
    state.wikiImportInsights = {
      sourceType: "chatgpt",
      totalItems: 1,
      totalClusters: 1,
      truncated: false,
      clusters: [],
    };
    state.wikiImportInsightsError = "unknown method: wiki.importInsights";

    await loadDreamingResource(state, "wikiImportInsights");

    expect(request).not.toHaveBeenCalled();
    expect(state.wikiImportInsights).toBeNull();
    expect(state.wikiImportInsightsError).toBeNull();
    expect(state.wikiImportInsightsLoading).toBe(false);
  });

  it("patches config to update global dreaming enablement", async () => {
    const { state } = createState();
    state.hello = gatewayHelloForMethods(["config.patch"]);
    state.configSnapshot = {
      hash: "hash-1",
      config: pluginConfig("memos-local-openclaw-plugin", {
        config: { dreaming: { enabled: true } },
      }),
    };
    const config = createConfig(state);

    await expect(updateDreamingEnabled(state, config, false)).resolves.toBe(true);
    expect(config.patch).toHaveBeenCalledWith({
      note: "Dreaming settings updated from the Dreaming tab.",
      raw: expect.any(Object),
      canDispatch: expect.any(Function),
    });
    expect(vi.mocked(config.patch).mock.calls[0]?.[0]?.raw).toEqual({
      plugins: {
        entries: { "memos-local-openclaw-plugin": { config: { dreaming: { enabled: false } } } },
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
    expect(vi.mocked(config.patch).mock.calls[0]?.[0]?.raw).toEqual({
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
      config: { plugins: { slots: { memory: "memory-lancedb" } } },
    };
    const config = createConfig(state);
    vi.mocked(config.lookupSchemaPath).mockResolvedValue({
      path: "plugins.entries.memory-lancedb.config",
      schema: { type: "object", additionalProperties: false },
      children: [
        { key: "retentionDays", path: "plugins.entries.memory-lancedb.config.retentionDays" },
      ],
    });

    await expect(updateDreamingEnabled(state, config, true)).resolves.toBe(false);
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
      resolveConfiguredDreaming(
        pluginConfig("memory-core", { config: { dreaming: { enabled: true } } }, "none"),
      ),
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

    await expect(updateDreamingEnabled(state, config, true)).resolves.toBe(false);
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

    await loadDreamingResource(state, "dreamDiary");

    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "main" });
    expect(state.dreamDiaryPath).toBe("DREAMS.md");
    expect(state.dreamDiaryContent).toBe("## Dream Diary\n- recurring glacier thoughts");
    expect(state.dreamDiaryError).toBeNull();
  });

  it("handles missing dream diary without error", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      found: false,
      path: "DREAMS.md",
    });

    await loadDreamingResource(state, "dreamDiary");

    expect(state.dreamDiaryPath).toBe("DREAMS.md");
    expect(state.dreamDiaryContent).toBeNull();
    expect(state.dreamDiaryError).toBeNull();
  });

  it("records dream diary request errors", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("dream diary read failed"));

    await loadDreamingResource(state, "dreamDiary");

    expect(state.dreamDiaryError).toBe("dream diary read failed");
    expect(state.dreamDiaryLoading).toBe(false);
  });

  it("does not run a write action with read-only operator access", async () => {
    const { state, request } = createState();
    state.hello = gatewayHelloForMethods(["doctor.memory.backfillDreamDiary"], ["operator.read"]);

    await expect(runDreamDiaryAction(state, "doctor.memory.backfillDreamDiary")).resolves.toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("runs dream diary actions and reloads state for the selected agent", async () => {
    const { state, request } = createActionState(
      "doctor.memory.backfillDreamDiary",
      { action: "backfill", written: 1 },
      { found: true, path: "DREAMS.md", content: "fish dreams" },
    );
    state.selectedAgentId = "fishing-bot";

    await expectActionReload(state, request, "doctor.memory.backfillDreamDiary", "fish dreams");
  });

  it("resets and reloads dream diary state", async () => {
    const { state, request } = createActionState(
      "doctor.memory.resetDreamDiary",
      { action: "reset", removedEntries: 79 },
      { found: false, path: "DREAMS.md" },
    );

    await expectActionReload(state, request, "doctor.memory.resetDreamDiary", null);
  });

  it("clears grounded staged entries and reloads only dreaming status", async () => {
    const { state, request } = createActionState("doctor.memory.resetGroundedShortTerm", {
      action: "resetGroundedShortTerm",
      removedShortTermEntries: 2,
    });
    state.dreamDiaryContent = "keep existing diary";

    await expectActionReload(
      state,
      request,
      "doctor.memory.resetGroundedShortTerm",
      "keep existing diary",
      false,
    );
  });

  it("repairs dreaming artifacts and reloads only dreaming status", async () => {
    const { state, request } = createActionState("doctor.memory.repairDreamingArtifacts", {
      action: "repairDreamingArtifacts",
      changed: true,
      archiveDir: "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
      archivedSessionCorpus: true,
      archivedSessionIngestion: true,
    });
    state.dreamDiaryContent = "keep existing diary";

    await expectActionReload(
      state,
      request,
      "doctor.memory.repairDreamingArtifacts",
      "keep existing diary",
      false,
    );
    expect(state.dreamDiaryActionMessage).toEqual({
      kind: "success",
      text: "Dream cache repair complete: archived session corpus, archived ingestion state. Archive: /tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
    });
    expect(state.dreamDiaryActionArchivePath).toBe(
      "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
    );
  });

  it("dedupes dream diary entries and reloads diary plus status", async () => {
    const { state, request } = createActionState(
      "doctor.memory.dedupeDreamDiary",
      {
        action: "dedupeDreamDiary",
        removedEntries: 2,
        keptEntries: 5,
      },
      { found: true, path: "DREAMS.md", content: "deduped diary" },
    );

    await expectActionReload(state, request, "doctor.memory.dedupeDreamDiary", "deduped diary");
    expect(state.dreamDiaryActionMessage).toEqual({
      kind: "success",
      text: "Removed 2 duplicate dream entries and kept 5.",
    });
    expect(state.dreamDiaryActionArchivePath).toBeNull();
  });

  it.each([
    { copied: true, kind: "success", text: "Archive path copied." },
    { copied: false, kind: "error", text: "Could not copy archive path." },
  ])("reports clipboard result: $kind", async ({ copied, kind, text }) => {
    const { state } = createState();
    state.dreamDiaryActionArchivePath = "/tmp/openclaw/archive";
    const writeText = copied
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);

    await expect(copyDreamingArchivePath(state)).resolves.toBe(copied);
    expect(writeText).toHaveBeenCalledWith("/tmp/openclaw/archive");
    expect(state.dreamDiaryActionMessage).toEqual({ kind, text });
  });
});
