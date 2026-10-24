// Session patch tests cover model/provider edits, subagent patching, provider
// aliases, model catalog validation, and rejected invalid patch payloads.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import { projectCanonicalSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../sessions/agent-harness-session-key.js";
import * as auth from "../sessions/auth-profile-preservation.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { withAgentSessionModelPatchOrigin } from "./session-model-patch-origin.js";
import {
  type ApplySessionsPatchArgs,
  MAIN_SESSION_KEY,
  runPatch as runPatchWithOptions,
  expectPatchOk,
  expectPatchError,
  mainStoreEntry,
} from "./sessions-patch.test-support.js";

const acpSessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionMetaForEntryAsync: vi.fn(),
}));
const providerThinkingMocks = vi.hoisted(() => ({
  resolveProviderThinkingProfile:
    vi.fn<typeof import("../plugins/provider-thinking.js").resolveEffectiveThinkingProfile>(),
}));

// mock-isolation: Patch projection fixtures provide ACP metadata without opening real session stores.
vi.mock("../acp/runtime/session-meta-readonly.js", () => ({
  readAcpSessionMetaForEntryAsync: acpSessionMetaMocks.readAcpSessionMetaForEntryAsync,
}));

// This suite owns patch projection; provider policy artifacts have dedicated contract coverage.
vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: providerThinkingMocks.resolveProviderThinkingProfile,
}));

const SUBAGENT_MODEL = "synthetic/hf:moonshotai/Kimi-K2.7-Code";
const KIMI_SUBAGENT_KEY = "agent:kimi:subagent:child";
const ANTHROPIC_SONNET_MODEL = "anthropic/claude-sonnet-4-6";
const ANTHROPIC_SONNET_ID = "claude-sonnet-4-6";
const ANTHROPIC_OPUS_MODEL = "anthropic/claude-opus-4-6";
const ANTHROPIC_OPUS_ID = "claude-opus-4-6";
const OPENAI_GPT_MODEL = "openai/gpt-5.4";
const OPENAI_GPT_ID = "gpt-5.4";

const applyAuthOverride = auth.applyModelOverrideWithAuthProfileCompatibility;
type ProviderAuthMetadataSnapshot = NonNullable<
  Parameters<typeof applyAuthOverride>[0]["metadataSnapshot"]
>;

const EMPTY_PROVIDER_AUTH_METADATA_SNAPSHOT = {
  plugins: [],
} satisfies ProviderAuthMetadataSnapshot;
const BYTEPLUS_PROVIDER_AUTH_METADATA_SNAPSHOT = {
  plugins: [
    {
      id: "byteplus",
      channels: [],
      providers: ["byteplus", "byteplus-plan"],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "bundled",
      rootDir: "/plugins/byteplus",
      source: "test",
      manifestPath: "/plugins/byteplus/openclaw.plugin.json",
      providerAuthAliases: { "byteplus-plan": "byteplus" },
    } satisfies PluginManifestRecord,
  ],
} satisfies ProviderAuthMetadataSnapshot;

type PatchFixture = Omit<Parameters<typeof runPatchWithOptions>[0], "patch"> &
  Omit<ApplySessionsPatchArgs["patch"], "key"> & {
    key?: string;
    mainEntry?: Partial<SessionEntry>;
  };
function runPatch({
  cfg,
  store,
  storeKey = MAIN_SESSION_KEY,
  agentId,
  loadGatewayModelCatalog,
  archivedBy,
  mainEntry,
  ...patch
}: PatchFixture) {
  return runPatchWithOptions({
    cfg,
    store: mainEntry === undefined ? store : mainStoreEntry(mainEntry),
    storeKey,
    agentId,
    loadGatewayModelCatalog,
    archivedBy,
    patch: { key: storeKey, ...patch },
  });
}
async function patchOk(options: PatchFixture) {
  return expectPatchOk(await runPatch(options));
}

type ModelDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
function agentConfig(
  defaults: ModelDefaults | undefined,
  entries?: NonNullable<OpenClawConfig["agents"]>["entries"],
): OpenClawConfig {
  return { agents: { ...(defaults ? { defaults } : {}), ...(entries ? { entries } : {}) } };
}
function modelConfig(primary: string, defaults: ModelDefaults = {}): OpenClawConfig {
  return agentConfig({ model: { primary }, ...defaults });
}

function mainAuthOverrideStore(overrides: Partial<SessionEntry>): Record<string, SessionEntry> {
  return mainStoreEntry({
    providerOverride: "anthropic",
    modelOverride: ANTHROPIC_OPUS_ID,
    authProfileOverrideSource: "user",
    ...overrides,
  });
}

function catalogEntry(ref: string, metadata: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  const separator = ref.indexOf("/");
  if (separator < 0) {
    throw new Error(`model ref must include provider: ${ref}`);
  }
  const id = ref.slice(separator + 1);
  return {
    provider: ref.slice(0, separator),
    id,
    name: id,
    ...metadata,
  };
}

function loadCatalog(...refs: string[]): ApplySessionsPatchArgs["loadGatewayModelCatalog"] {
  return async () => refs.map((ref) => catalogEntry(ref));
}

function expectModelSelection(
  entry: SessionEntry,
  providerOverride: string | undefined,
  modelOverride: string | undefined,
) {
  expect([entry.providerOverride, entry.modelOverride]).toEqual([providerOverride, modelOverride]);
}

async function applyMainModelPatch(params: {
  store?: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  model: string | null;
  catalogRefs?: string[];
  providerAuthMetadataSnapshot?: ProviderAuthMetadataSnapshot;
}) {
  const metadataSnapshot =
    params.providerAuthMetadataSnapshot ?? EMPTY_PROVIDER_AUTH_METADATA_SNAPSHOT;
  using _ = vi
    .spyOn(auth, "applyModelOverrideWithAuthProfileCompatibility")
    .mockImplementation((options) => applyAuthOverride({ ...options, metadataSnapshot }));
  return await patchOk({
    store: params.store,
    cfg: params.cfg,
    model: params.model,
    loadGatewayModelCatalog:
      params.catalogRefs === undefined ? undefined : loadCatalog(...params.catalogRefs),
  });
}

function expectAuthOverride(
  entry: SessionEntry,
  expected: {
    profile: string | undefined;
    source?: string;
    compactionCount?: number;
  },
) {
  expect([
    entry.authProfileOverride,
    entry.authProfileOverrideSource,
    entry.authProfileOverrideCompactionCount,
  ]).toEqual([
    expected.profile,
    expected.profile === undefined ? undefined : (expected.source ?? "user"),
    expected.profile === undefined ? undefined : expected.compactionCount,
  ]);
}

async function applySubagentModelPatch(cfg: OpenClawConfig, store: Record<string, SessionEntry>) {
  return runPatch({
    cfg,
    store,
    storeKey: KIMI_SUBAGENT_KEY,
    model: SUBAGENT_MODEL,
    loadGatewayModelCatalog: async () => [
      { provider: "anthropic", id: ANTHROPIC_SONNET_ID, name: "sonnet" },
      { provider: "synthetic", id: "hf:moonshotai/Kimi-K2.7-Code", name: "kimi" },
    ],
  });
}

function makeKimiSubagentCfg(params: {
  allowModel: boolean;
  agentPrimaryModel?: string;
  agentSubagentModel?: string;
  defaultsSubagentModel?: string;
}): OpenClawConfig {
  return agentConfig(
    {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      modelPolicy: { allow: [ANTHROPIC_SONNET_MODEL] },
      subagents: params.defaultsSubagentModel ? { model: params.defaultsSubagentModel } : undefined,
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "default" },
      },
    },
    {
      kimi: {
        ...(params.allowModel ? { modelPolicy: { allow: [SUBAGENT_MODEL] } } : {}),
        model: params.agentPrimaryModel ? { primary: params.agentPrimaryModel } : undefined,
        subagents: params.agentSubagentModel ? { model: params.agentSubagentModel } : undefined,
      },
    },
  );
}

function createAllowlistedAnthropicModelCfg(): OpenClawConfig {
  return modelConfig(OPENAI_GPT_MODEL, {
    models: {
      [ANTHROPIC_SONNET_MODEL]: { alias: "sonnet" },
    },
  });
}

describe("gateway sessions patch", () => {
  beforeAll(async () => {
    await prepareSharedAuthStoreOwnership();
  });

  beforeEach(() => {
    providerThinkingMocks.resolveProviderThinkingProfile.mockReset();
    providerThinkingMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) => {
        if (provider !== "openai") {
          return undefined;
        }
        const base = ["off", "minimal", "low", "medium", "high"] as const;
        const levels =
          context.modelId === "gpt-5.5"
            ? ([...base, "xhigh"] as const)
            : context.modelId === "gpt-5.6-luna"
              ? context.agentRuntime === "openclaw"
                ? ([...base, "max", "ultra"] as const)
                : ([...base, "max"] as const)
              : undefined;
        return levels && { levels: levels.map((id) => ({ id })) };
      },
    );
  });

  afterEach(() => {
    acpSessionMetaMocks.readAcpSessionMetaForEntryAsync.mockReset();
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
  });

  test("keeps a custom SVG icon through store normalization, unrelated patches, and clearing", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
    const icon = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const store = mainStoreEntry({ label: "Night watch", color: "purple" });
    const patch = async (fields: { icon?: string | null; label?: string }) =>
      runPatch({ store, ...fields });
    const entry = expectPatchOk(await patch({ icon: svg }));
    expect(entry).toMatchObject({ icon, color: "purple" });
    store[MAIN_SESSION_KEY] = projectCanonicalSessionEntryShape({ ...entry });
    expect(expectPatchOk(await patch({ label: "Updated night watch" }))).toMatchObject({ icon });
    expectPatchError(await patch({ icon: "https://example.com/icon.svg" }), "icon must be");
    expect(store[MAIN_SESSION_KEY].icon).toBe(icon);
    expect(expectPatchOk(await patch({ icon: null })).icon).toBeUndefined();
    expect(store[MAIN_SESSION_KEY].color).toBe("purple");
  });

  test("keeps manual renames independent of automatic device-label writes and clears", async () => {
    const key = "agent:main:node-1234567890ab";
    const autoLabel = "OpenClaw App · Pixel · 1234567890ab";
    const label = "OpenClaw App · Release planning · 1234567890ab";
    const store: Record<string, SessionEntry> = {};
    const patch = async (fields: { label?: string | null; autoLabel?: string | null }) =>
      await patchOk({ store, storeKey: key, ...fields });

    expect(await patch({ autoLabel })).toMatchObject({ autoLabel });
    await patch({ label });
    // A reconnect can finish after a manual rename; the automatic writer owns a different field.
    expect(await patch({ autoLabel: "Updated device" })).toMatchObject({
      label,
      autoLabel: "Updated device",
    });
    const cleared = await patch({ label: null });
    expect(cleared.label).toBeUndefined();
    expect(cleared.autoLabel).toBe("Updated device");
    expect((await patch({ autoLabel: null })).autoLabel).toBeUndefined();

    // Automatic names do not participate in unique custom-label lookup.
    store.other = { sessionId: "other", updatedAt: 1, label: autoLabel, autoLabel };
    expect(await patch({ autoLabel })).toMatchObject({ autoLabel });
  });

  test.each([false, true])("patches harness sessions only when existing=%s", async (existing) => {
    const key = "agent:main:harness:codex:supervision:session";
    const store: Record<string, SessionEntry> = existing
      ? {
          [key]: {
            sessionId: "harness-session",
            updatedAt: 1,
            agentHarnessId: "codex",
            modelSelectionLocked: true,
          },
        }
      : {};

    const result = await runPatch({ store, storeKey: key, label: "kept" });
    if (!existing) {
      expectPatchError(result, AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
      expect(store[key]).toBeUndefined();
      return;
    }
    const entry = expectPatchOk(result);
    expect(entry.label).toBe("kept");
    expect(store[key]).toMatchObject({
      sessionId: "harness-session",
      label: "kept",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });
  });

  test("attributes the archive transition and clears attribution on restore", async () => {
    const archivedBy = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const archived = await patchOk({
      mainEntry: { pinnedAt: 10 },
      archived: true,
      expectedSessionId: "sess",
      archivedBy,
    });
    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(archived.archivedBy).toEqual(archivedBy);
    expect(archived.archiveReason).toBe("manual");
    expect(archived.pinnedAt).toBeUndefined();

    const idempotent = await patchOk({
      mainEntry: {
        archivedAt: archived.archivedAt,
        archivedBy,
        archiveReason: "manual",
      },
      archived: true,
      expectedSessionId: "sess",
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
    });
    expect(idempotent.archivedAt).toBe(archived.archivedAt);
    expect(idempotent.archivedBy).toEqual(archivedBy);
    expect(idempotent.archiveReason).toBe("manual");

    const restored = await patchOk({
      store: { [MAIN_SESSION_KEY]: idempotent },
      archived: false,
      expectedSessionId: "sess",
    });
    expect([restored.archivedAt, restored.archivedBy, restored.archiveReason]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("does not fabricate archive attribution without an actor", async () => {
    const archived = await patchOk({ mainEntry: {}, archived: true, expectedSessionId: "sess" });

    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(archived.archivedBy).toBeUndefined();
  });

  const childPinError = "cannot pin a child session; pin its parent session instead";
  test.each<[string, Partial<SessionEntry>, boolean, string?]>([
    [MAIN_SESSION_KEY, {}, false],
    [MAIN_SESSION_KEY, { archivedAt: 10 }, true, "restore it first"],
    [
      "agent:main:dashboard:child",
      { pinnedAt: 10, spawnedBy: MAIN_SESSION_KEY },
      true,
      childPinError,
    ],
    [
      "agent:main:dashboard:child",
      { pinnedAt: 10, parentSessionKey: "agent:main:dashboard:parent" },
      true,
      childPinError,
    ],
    ["agent:main:subagent:child", { pinnedAt: 10 }, true, childPinError],
    ["agent:main:dashboard:root", { spawnedBy: "  ", parentSessionKey: "  " }, true],
    ["agent:main:dashboard:work", { parentSessionKey: MAIN_SESSION_KEY }, true],
  ])("validates pin eligibility on %s with %j", async (key, fields, existing, error) => {
    const result = await runPatch({
      storeKey: key,
      store: existing ? { [key]: { sessionId: "session", updatedAt: 1, ...fields } } : {},
      pinned: true,
    });
    if (error) {
      expectPatchError(result, error);
    } else {
      expect(expectPatchOk(result).pinnedAt).toEqual(expect.any(Number));
    }
  });

  test.each([{ pinned: false }, { label: "Child task" }] as const)(
    "clears stale child pins on a metadata or unpin patch: %j",
    async (patch) => {
      const key = "agent:main:dashboard:child";
      const updated = await patchOk({
        storeKey: key,
        store: {
          [key]: { sessionId: "child", updatedAt: 1, pinnedAt: 10, spawnedBy: MAIN_SESSION_KEY },
        },
        ...patch,
      });
      expect(updated.pinnedAt).toBeUndefined();
    },
  );

  test("preserves existing pins on Home-parented sessions through metadata patches", async () => {
    const key = "agent:main:dashboard:work";
    const updated = await patchOk({
      storeKey: key,
      store: {
        [key]: {
          sessionId: "work",
          updatedAt: 1,
          pinnedAt: 10,
          parentSessionKey: MAIN_SESSION_KEY,
        },
      },
      label: "Work session",
    });
    expect(updated.pinnedAt).toBe(10);
  });

  test("marks archived sessions unread and clears the marker when read", async () => {
    const store = mainStoreEntry({
      archivedAt: 10,
      lastReadAt: 20,
      agentStatus: { note: "Waiting", attention: "hand", expiresAt: Date.now() + 60_000 },
    });
    const unread = await patchOk({ store, unread: true });
    expect(unread.archivedAt).toBe(10);
    expect(unread.lastReadAt).toBe(20);
    expect(unread.markedUnreadAt).toEqual(expect.any(Number));

    const read = await patchOk({ store, unread: false });
    expect(read.archivedAt).toBe(10);
    expect(read.lastReadAt).toEqual(expect.any(Number));
    expect(read.lastReadAt).toBeGreaterThanOrEqual(unread.markedUnreadAt ?? 0);
    expect(read.markedUnreadAt).toBeUndefined();
    expect(read.agentStatus).toBeUndefined();
  });

  test("commits a read acknowledgement without ageing the session row", async () => {
    const store = mainStoreEntry({
      markedUnreadAt: 40,
      agentStatus: { note: "Waiting", attention: "hand", expiresAt: Date.now() + 60_000 },
    });

    const read = await patchOk({ store, unread: false, expectedMarkedUnreadAt: 40 });
    expect(read.updatedAt).toBe(1);
    expect(read.lastReadAt).toEqual(expect.any(Number));
    expect(read.markedUnreadAt).toBeUndefined();
    expect(read.agentStatus).toBeUndefined();

    const marked = await patchOk({ store, unread: true });
    expect(marked.updatedAt).toBeGreaterThan(1);
    expect(marked.markedUnreadAt).toEqual(expect.any(Number));

    const pinned = await patchOk({
      mainEntry: { markedUnreadAt: 40 },
      pinned: true,
      unread: false,
    });
    expect(pinned.pinnedAt).toEqual(expect.any(Number));
    expect(pinned.updatedAt).toBeGreaterThan(1);
  });

  test("commits an icon or color change without ageing the session row", async () => {
    const store = mainStoreEntry({ sessionId: "sess-icon" });

    const iconed = await patchOk({ store, icon: "✅", expectedSessionId: "sess-icon" });
    expect(iconed.icon).toBe("✅");
    expect(iconed.updatedAt).toBe(1);

    const cleared = await patchOk({ store, icon: null, color: null });
    expect(cleared.icon).toBeUndefined();
    expect(cleared.updatedAt).toBe(1);

    const renamed = await patchOk({ store, icon: "🐛", label: "Waiting" });
    expect(renamed.icon).toBe("🐛");
    expect(renamed.updatedAt).toBeGreaterThan(1);
  });

  test("stores sanitized agent status with attention and a bounded TTL", async () => {
    const before = Date.now();
    const entry = await patchOk({
      mainEntry: {},
      statusNote: "  Blocked:\n need the staging password  ",
      attention: "key",
    });
    expect(entry.agentStatus).toMatchObject({
      note: "Blocked: need the staging password",
      attention: "key",
    });
    expect(entry.agentStatus?.expiresAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(entry.agentStatus?.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);

    expectPatchError(
      await runPatch({ mainEntry: {}, statusNote: "Waiting", ttlMinutes: 121 }),
      "use 1-120",
    );
  });

  test("clears the whole agent status explicitly", async () => {
    const entry = await patchOk({
      mainEntry: {
        agentStatus: { note: "Waiting", attention: "flag", expiresAt: Date.now() + 60_000 },
      },
      attention: null,
    });
    expect(entry.agentStatus).toBeUndefined();
  });

  test.each(["thinkingLevel", "contextWindow", "elevatedLevel"] as const)(
    "clears %s without loading the catalog",
    async (field) => {
      const store = mainStoreEntry({
        ...(field === "elevatedLevel" ? { sessionId: undefined } : {}),
        thinkingLevel: "low",
        contextWindow: "extended",
        elevatedLevel: "off",
      });
      const loadGatewayModelCatalog = vi.fn(async () => {
        throw new Error("Catalog must not be needed for a clear");
      });
      const entry = await patchOk({ store, [field]: null, loadGatewayModelCatalog });
      expect(entry[field]).toBeUndefined();
      expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    },
  );

  test("recreates partial rows without dropping session settings", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        updatedAt: 1,
        sessionFile: "stale.jsonl",
        label: "Stale Session",
        sendPolicy: "deny",
        modelOverride: OPENAI_GPT_ID,
        liveModelSwitchPending: true,
        responseUsage: "tokens",
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };
    const entry = await patchOk({ store, fastMode: true });

    expect(entry.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(entry.sessionFile).toBeUndefined();
    expect(entry.label).toBeUndefined();
    expect(entry.sendPolicy).toBe("deny");
    expect(entry.modelOverride).toBe(OPENAI_GPT_ID);
    expect(entry.liveModelSwitchPending).toBeUndefined();
    expect(entry.responseUsage).toBe("tokens");
    expect(entry.parentSessionKey).toBe("agent:main:main");
    expect(entry.fastMode).toBe(true);
  });

  test.each([
    { field: "category", raw: "  Research  ", normalized: "Research" },
    { field: "color", raw: "  Blue ", normalized: "blue" },
    { field: "verboseLevel", raw: "  EVERYTHING  ", normalized: "full" },
    { field: "traceLevel", raw: "  UNFILTERED  ", normalized: "raw" },
  ] as const)("normalizes and clears $field", async ({ field, raw, normalized }) => {
    const entry = await patchOk({ mainEntry: {}, [field]: raw });
    expect(entry[field]).toBe(normalized);

    const cleared = await patchOk({ mainEntry: { [field]: normalized }, [field]: null });
    expect(cleared[field]).toBeUndefined();
  });

  test.each(["ultrafast"] as const)("sets fastMode to %s", async (fastMode) => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {} as SessionEntry,
    };
    const entry = await patchOk({ store, fastMode });

    expect(entry.fastMode).toBe(fastMode);
  });

  test("sets, replaces, clears, and normalizes tool overrides", async () => {
    const store = mainStoreEntry({});
    const set = await patchOk({
      store,
      toolOverrides: {
        mcpServers: { zeta: false, alpha: true },
        mcpToolsDeny: { zeta: [], alpha: ["write", "read", "write"] },
        skills: {},
        webSearch: true,
      },
    });
    expect(set.toolOverrides).toEqual({
      mcpServers: { alpha: true, zeta: false },
      mcpToolsDeny: { alpha: ["read", "write"] },
    });

    const replaced = await patchOk({ store, toolOverrides: { skills: { release: false } } });
    expect(replaced.toolOverrides).toEqual({ skills: { release: false } });

    const normalizedEmpty = await patchOk({ store, toolOverrides: { mcpToolsDeny: { docs: [] } } });
    expect(normalizedEmpty.toolOverrides).toBeUndefined();

    store[MAIN_SESSION_KEY] = {
      ...normalizedEmpty,
      toolOverrides: { webSearch: false },
    };
    const cleared = await patchOk({ store, toolOverrides: null });
    expect(cleared.toolOverrides).toBeUndefined();
  });

  test.each([
    { patch: { verboseLevel: "maybe" }, error: 'invalid verboseLevel (use "on"|"off"|"full")' },
    { patch: { traceLevel: "maybe" }, error: 'invalid traceLevel (use "on"|"off"|"raw")' },
    {
      patch: { verboseLevel: "maybe", traceLevel: "maybe" },
      error: 'invalid verboseLevel (use "on"|"off"|"full")',
    },
    { patch: { elevatedLevel: "maybe" }, error: "invalid elevatedLevel" },
    {
      patch: { color: "crimson" },
      error: "color must be one of: red, blue, green, yellow, purple, orange, pink, cyan",
    },
    { patch: { inheritedToolDeny: ["exec"] }, error: "inheritedToolDeny is only supported" },
    {
      patch: { inheritedToolPolicyVersion: 1 },
      error: "inheritedToolPolicyVersion is only supported",
    },
    { patch: { inheritedToolAllow: ["read"] }, error: "inheritedToolAllow is only supported" },
    { patch: { execHost: "edge" }, error: "invalid execHost" },
    { patch: { sendPolicy: "ask" as unknown as "allow" }, error: "invalid sendPolicy" },
    {
      patch: { groupActivation: "never" as unknown as "mention" },
      error: "invalid groupActivation",
    },
  ] satisfies { patch: Omit<ApplySessionsPatchArgs["patch"], "key">; error: string }[])(
    "rejects $patch: $error",
    async ({ patch, error }) => {
      const result = await runPatch({ ...patch });
      expectPatchError(result, error);
    },
  );

  const anthropicSelection = {
    model: ANTHROPIC_SONNET_MODEL,
    provider: "anthropic",
    modelId: ANTHROPIC_SONNET_ID,
  };

  test.each([
    {
      name: "provider auth alias",
      overrides: {
        providerOverride: "byteplus",
        modelOverride: "seedance-1-0-lite-t2v-250428",
        authProfileOverride: "byteplus:work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      },
      model: "byteplus-plan/ark-code-latest",
      provider: "byteplus-plan",
      modelId: "ark-code-latest",
      providerAuthMetadataSnapshot: BYTEPLUS_PROVIDER_AUTH_METADATA_SNAPSHOT,
      expected: { profile: "byteplus:work", compactionCount: 2 },
    },
    {
      name: "unprefixed default provider",
      overrides: {
        authProfileOverride: "work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 4,
        providerOverride: undefined,
        modelOverride: undefined,
      },
      cfg: modelConfig(`anthropic/${ANTHROPIC_OPUS_ID}`) satisfies OpenClawConfig,
      ...anthropicSelection,
      expected: { profile: "work", compactionCount: 4 },
    },
    {
      name: "unprefixed provider change",
      overrides: {
        authProfileOverride: "work",
        authProfileOverrideCompactionCount: 4,
      },
      model: OPENAI_GPT_MODEL,
      provider: "openai",
      modelId: OPENAI_GPT_ID,
      expected: { profile: undefined },
    },
  ] satisfies {
    name: string;
    overrides: Partial<SessionEntry>;
    model: string;
    provider: string;
    modelId: string;
    expected: Parameters<typeof expectAuthOverride>[1];
    cfg?: OpenClawConfig;
    providerAuthMetadataSnapshot?: ProviderAuthMetadataSnapshot;
  }[])("preserves only compatible auth overrides: $name", async (scenario) => {
    const entry = await applyMainModelPatch({
      ...scenario,
      store: mainAuthOverrideStore(scenario.overrides),
      catalogRefs: [scenario.model],
    });
    expectModelSelection(entry, scenario.provider, scenario.modelId);
    expectAuthOverride(entry, scenario.expected);
  });

  test.each([
    { name: "change", model: ANTHROPIC_SONNET_MODEL },
    { name: "reset", model: null },
  ])("rejects locked model $name patches before catalog loading", async ({ model }) => {
    const store = mainStoreEntry({
      sessionId: "sess-model-locked",
      providerOverride: "openai",
      modelOverride: OPENAI_GPT_ID,
      modelSelectionLocked: true,
    });
    const before = { ...store[MAIN_SESSION_KEY] };
    const loadGatewayModelCatalog = vi.fn(loadCatalog(ANTHROPIC_SONNET_MODEL));

    const result = await runPatch({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      model,
      loadGatewayModelCatalog,
    });

    expectPatchError(result, MODEL_SELECTION_LOCKED_MESSAGE);
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    expect(store[MAIN_SESSION_KEY]).toEqual(before);
  });

  test.each(["fresh", "placeholder", "existing"] as const)(
    "queues model switches only for existing sessions (%s)",
    async (sessionState) => {
      const store =
        sessionState === "fresh"
          ? undefined
          : mainStoreEntry({
              sessionId: sessionState === "existing" ? "sess-live" : undefined,
              providerOverride: "openai",
              modelOverride: OPENAI_GPT_ID,
              modelFallback: {
                prevModel: OPENAI_GPT_ID,
                prevProvider: "openai",
                ts: 1,
                source: "agent-patch",
              },
            });
      const entry = await applyMainModelPatch({
        store,
        cfg: createAllowlistedAnthropicModelCfg(),
        model: ANTHROPIC_SONNET_MODEL,
        catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL],
      });

      expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
      expect(entry.liveModelSwitchPending).toBe(sessionState === "existing" ? true : undefined);
      expect(entry.modelFallback).toBeUndefined();
    },
  );

  test("snapshots prior selection atomically and retains it across consecutive agent patches", async () => {
    const cfg = createAllowlistedAnthropicModelCfg();
    cfg.agents!.defaults!.models![ANTHROPIC_OPUS_MODEL] = { alias: "opus" };
    const store = mainStoreEntry({
      providerOverride: "openai",
      modelOverride: OPENAI_GPT_ID,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-primary",
      authProfileOverride: "openai:good",
      authProfileOverrideSource: "user",
      thinkingLevel: "high",
    });
    const entry = await withAgentSessionModelPatchOrigin(
      async () =>
        await applyMainModelPatch({
          store,
          cfg,
          model: ANTHROPIC_SONNET_MODEL,
          catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL],
        }),
    );

    expect(entry.modelFallback).toMatchObject({
      prevModel: OPENAI_GPT_ID,
      prevProvider: "openai",
      prevModelOverrideSource: "auto",
      prevModelOverrideFallbackOriginProvider: "openai",
      prevModelOverrideFallbackOriginModel: "gpt-primary",
      prevAuthProfileOverride: "openai:good",
      prevThinkingLevel: "high",
      source: "agent-patch",
    });
    const firstMarker = entry.modelFallback;

    const second = await withAgentSessionModelPatchOrigin(
      async () =>
        await applyMainModelPatch({
          store: { [MAIN_SESSION_KEY]: entry },
          cfg,
          model: ANTHROPIC_OPUS_MODEL,
          catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL, ANTHROPIC_OPUS_MODEL],
        }),
    );

    expect(second.modelFallback).toMatchObject({
      prevModel: OPENAI_GPT_ID,
      prevProvider: "openai",
    });
    expect(second.modelFallback?.ts).toBeGreaterThan(firstMarker?.ts ?? 0);
  });

  test.each([
    { patch: { thinkingLevel: "low" }, thinking: "low", context: "extended" },
    { patch: { contextWindow: null }, thinking: "high", context: undefined },
    {
      patch: { contextWindow: null, thinkingLevel: null },
      thinking: undefined,
      context: undefined,
    },
  ] as const)(
    "realigns rollback metadata without mutating its input: $patch",
    async ({ patch, thinking, context }) => {
      const store = mainStoreEntry({
        modelOverride: ANTHROPIC_SONNET_ID,
        providerOverride: "anthropic",
        thinkingLevel: "high",
        contextWindow: "extended",
        modelFallback: {
          prevModel: OPENAI_GPT_ID,
          prevProvider: "openai",
          prevThinkingLevel: "high",
          prevContextWindow: "extended",
          ts: 1,
          source: "agent-patch",
        },
      });
      const input = store[MAIN_SESSION_KEY]!;
      const before = structuredClone(input);
      const entry = await patchOk({ store, ...patch });
      expect(entry.thinkingLevel).toBe(thinking);
      expect(entry.contextWindow).toBe(context);
      expect(entry.modelFallback).toMatchObject({
        prevModel: OPENAI_GPT_ID,
        prevProvider: "openai",
        prevThinkingLevel: thinking,
        prevContextWindow: context,
        ts: 1,
        source: "agent-patch",
      });
      expect(input).toEqual(before);
    },
  );

  test("clears pending live model switches for model reset patches", async () => {
    const store = mainStoreEntry({
      sessionId: "sess-live-reset",
      providerOverride: "anthropic",
      modelOverride: ANTHROPIC_SONNET_ID,
      modelOverrideSource: "user",
      liveModelSwitchPending: true,
    });
    const loadGatewayModelCatalog = vi.fn(async () => {
      throw new Error("Catalog must not be needed for an unqualified reset");
    });
    const entry = await patchOk({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      model: null,
      loadGatewayModelCatalog,
    });

    expectModelSelection(entry, undefined, undefined);
    expect(entry.modelOverrideSource).toBe("default");
    expect(entry.liveModelSwitchPending).toBeUndefined();
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  test.each([true, false])(
    "model reset revalidates retained selections once (context supported: %s)",
    async (supported) => {
      const loadGatewayModelCatalog = vi.fn(async () => [
        {
          ...catalogEntry(ANTHROPIC_SONNET_MODEL),
          reasoning: true,
          contextWindows: supported
            ? [{ id: "extended", label: "Extended", contextWindow: 200_000 }]
            : [],
        },
      ]);
      const entry = await patchOk({
        cfg: agentConfig({ model: ANTHROPIC_SONNET_MODEL }),
        mainEntry: {
          providerOverride: "anthropic",
          modelOverride: ANTHROPIC_OPUS_ID,
          thinkingLevel: "high",
          contextWindow: "extended",
        },
        model: null,
        loadGatewayModelCatalog,
      });
      expectModelSelection(entry, undefined, undefined);
      expect(entry.thinkingLevel).toBe("high");
      expect(entry.contextWindow).toBe(supported ? "extended" : undefined);
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
    },
  );

  test("one catalog prepares a combined model, thinking, and context-window patch", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => [
      {
        ...catalogEntry(ANTHROPIC_SONNET_MODEL),
        reasoning: true,
        contextWindows: [{ id: "extended", label: "Extended", contextWindow: 200_000 }],
      },
    ]);
    const entry = await patchOk({
      cfg: createAllowlistedAnthropicModelCfg(),
      mainEntry: {},
      model: ANTHROPIC_SONNET_MODEL,
      thinkingLevel: "high",
      contextWindow: "extended",
      loadGatewayModelCatalog,
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expect(entry).toMatchObject({ thinkingLevel: "high", contextWindow: "extended" });
    expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
  });

  test.each([
    { patch: { category: "" }, message: "invalid category" },
    { patch: { model: "" }, message: "invalid model: empty" },
  ])(
    "preserves early validation before catalog preparation: $message",
    async ({ patch, message }) => {
      const loadGatewayModelCatalog = vi.fn(async () => {
        throw new Error("Catalog failure must not replace early validation");
      });
      const store = mainStoreEntry({ label: "Original" });
      expectPatchError(
        await runPatch({ store, contextWindow: "extended", ...patch, loadGatewayModelCatalog }),
        message,
      );
      expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
      expect(store[MAIN_SESSION_KEY]).toEqual({
        sessionId: "sess",
        updatedAt: 1,
        label: "Original",
      });
    },
  );

  test.each([
    { name: "explicit allowlist", agentPolicy: undefined },
    { name: "unrestricted default policy", agentPolicy: false },
    { name: "unrestricted agent policy", agentPolicy: true },
  ])("accepts uncataloged refs: $name", async ({ agentPolicy }) => {
    const explicitAllowlist = agentPolicy === undefined;
    const cfg = explicitAllowlist
      ? createAllowlistedAnthropicModelCfg()
      : (agentConfig(
          {
            model: { primary: "synthetic/primary" },
            modelPolicy: { allow: agentPolicy ? ["synthetic/primary"] : [] },
          },
          { main: agentPolicy ? { modelPolicy: { allow: [] } } : {} },
        ) satisfies OpenClawConfig);
    const key = explicitAllowlist ? MAIN_SESSION_KEY : "global";
    const entry = await patchOk({
      cfg,
      storeKey: key,
      model: explicitAllowlist ? ANTHROPIC_SONNET_MODEL : "synthetic/uncataloged",
      loadGatewayModelCatalog: loadCatalog(...(explicitAllowlist ? [OPENAI_GPT_MODEL] : [])),
    });
    expectModelSelection(
      entry,
      explicitAllowlist ? "anthropic" : "synthetic",
      explicitAllowlist ? ANTHROPIC_SONNET_ID : "uncataloged",
    );
    expect(entry.modelOverrideSource).toBe("user");
  });

  test("enforces the default agent policy without an explicit agent or qualified key", async () => {
    const key = "global";
    const existing: SessionEntry = { sessionId: "default-policy", updatedAt: 1, label: "Original" };
    const store = { [key]: existing };
    const result = await runPatch({
      cfg: agentConfig(
        { model: "synthetic/primary", modelPolicy: { allow: [] } },
        { main: { modelPolicy: { allow: ["synthetic/allowed"] } } },
      ),
      store,
      storeKey: key,
      model: "synthetic/outside",
      label: "Changed",
      loadGatewayModelCatalog: loadCatalog("synthetic/allowed", "synthetic/outside"),
    });

    expectPatchError(result, "model not allowed: synthetic/outside");
    expect(store[key]).toEqual(existing);
  });

  test.each(["fresh", "placeholder", "existing"] as const)(
    "validates context-window initialization without queuing fresh-session switches (%s)",
    async (sessionState) => {
      const cfg = modelConfig("claude-cli/claude-fable-5");
      const loadGatewayModelCatalog = async () => [
        catalogEntry("claude-cli/claude-fable-5", {
          name: "Claude Fable 5",
          contextWindow: 1_000_000,
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
        }),
      ];

      const entry = await patchOk({
        cfg,
        store:
          sessionState === "fresh"
            ? undefined
            : mainStoreEntry({
                sessionId: sessionState === "existing" ? "sess-context" : undefined,
                contextBudgetStatus: contextBudgetStatusFixture(),
              }),
        contextWindow: "200k",
        loadGatewayModelCatalog,
      });
      expect(entry.contextWindow).toBe("200k");
      expect(entry.contextBudgetStatus).toBeUndefined();
      expect(entry.liveModelSwitchPending).toBe(sessionState === "existing" ? true : undefined);

      const invalid = await runPatch({ cfg, contextWindow: "2m", loadGatewayModelCatalog });
      expectPatchError(invalid, 'contextWindow "2m" is not supported');
    },
  );

  test("rejects thinking levels forbidden by the concrete runtime policy", async () => {
    providerThinkingMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "claude-cli"
        ? { levels: [{ id: "off" }], defaultLevel: "off" }
        : {
            levels: [{ id: "minimal" }, { id: "medium" }, { id: "adaptive" }],
            defaultLevel: "adaptive",
            preserveWhenCatalogReasoningFalse: true,
          },
    );

    const result = await runPatch({
      cfg: modelConfig("anthropic/claude-mythos-5"),
      thinkingLevel: "medium",
      loadGatewayModelCatalog: async () => [
        catalogEntry("anthropic/claude-mythos-5", {
          name: "Claude Mythos 5",
          reasoning: false,
          thinkingPolicyProvider: "claude-cli",
        }),
      ],
    });

    expectPatchError(result, 'thinkingLevel "medium" is not supported');
  });

  test("validates global patches against the selected agent", async () => {
    const entry = await patchOk({
      cfg: agentConfig(undefined, {
        main: {
          model: { primary: "gmn/gpt-5.4" },
        },
        work: {
          model: { primary: "openai/gpt-5.5" },
        },
      }) as OpenClawConfig,
      storeKey: "global",
      agentId: "work",
      thinkingLevel: "xhigh",
      loadGatewayModelCatalog: async () => [],
    });

    expect(entry.thinkingLevel).toBe("xhigh");
  });

  test.each(["configured", "session"] as const)(
    "validates Ultra with the %s runtime override",
    async (source) => {
      const entry = await patchOk({
        cfg: modelConfig("openai/gpt-5.6-luna", {
          models:
            source === "configured"
              ? {
                  "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
                }
              : undefined,
        }),
        store:
          source === "session"
            ? mainStoreEntry({
                agentRuntimeOverride: "openclaw",
                agentHarnessId: "codex",
              })
            : undefined,
        thinkingLevel: "ultra",
        loadGatewayModelCatalog: async () => [],
      });

      expect(entry.thinkingLevel).toBe("ultra");
    },
  );

  test("preserves stored Ultra when a model patch selects Codex Luna", async () => {
    const entry = await patchOk({
      cfg: modelConfig("openai/gpt-5.6-sol", {
        models: {
          "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
        },
      }),
      mainEntry: { thinkingLevel: "ultra" },
      model: "openai/gpt-5.6-luna",
      loadGatewayModelCatalog: loadCatalog("openai/gpt-5.6-sol", "openai/gpt-5.6-luna"),
    });

    expect(entry.thinkingLevel).toBe("ultra");
  });

  test("clearing a runtime pin preserves supported thinking and invalidates derived context", async () => {
    const entry = await patchOk({
      cfg: agentConfig({ model: "openai/gpt-5.6-luna" }),
      mainEntry: {
        agentRuntimeOverride: "openclaw",
        thinkingLevel: "ultra",
        contextTokens: 1000,
      },
      agentRuntime: null,
      loadGatewayModelCatalog: loadCatalog("openai/gpt-5.6-luna"),
    });
    expect(entry).toMatchObject({ thinkingLevel: "ultra", liveModelSwitchPending: true });
    expect(entry).not.toHaveProperty("agentRuntimeOverride");
    expect(entry).not.toHaveProperty("contextTokens");
  });

  test.each([null, "openclaw"])(
    "retains locked model and runtime ownership (%s)",
    async (agentRuntime) => {
      const store = mainStoreEntry({ modelSelectionLocked: true, agentRuntimeOverride: "codex" });
      expectPatchError(
        await runPatch({
          store,
          agentRuntime,
          ...(agentRuntime ? { model: "openai/gpt-5.6-sol" } : {}),
        }),
        MODEL_SELECTION_LOCKED_MESSAGE,
      );
      expect(store[MAIN_SESSION_KEY]?.agentRuntimeOverride).toBe("codex");
    },
  );

  test("does not persist a misleading runtime pin on an ACP-owned session", async () => {
    acpSessionMetaMocks.readAcpSessionMetaForEntryAsync.mockResolvedValue({
      backend: "codex",
      agent: "main",
      state: "idle",
    });
    expectPatchError(
      await runPatch({ mainEntry: {}, agentRuntime: null }),
      "owned by this ACP session",
    );
  });

  test("uses ACP backend metadata on canonical agent keys for thinking validation", async () => {
    acpSessionMetaMocks.readAcpSessionMetaForEntryAsync.mockResolvedValue({
      backend: "codex",
      agent: "main",
      runtimeSessionName: MAIN_SESSION_KEY,
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    });

    const result = await runPatch({
      cfg: modelConfig("openai/gpt-5.6-luna", {
        models: {
          "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
        },
      }),
      mainEntry: {},
      thinkingLevel: "xhigh",
      loadGatewayModelCatalog: async () => [],
    });

    expectPatchError(result, 'thinkingLevel "xhigh" is not supported');
    expect(acpSessionMetaMocks.readAcpSessionMetaForEntryAsync).toHaveBeenCalledWith({
      sessionKey: MAIN_SESSION_KEY,
      agentId: "main",
      entry: expect.objectContaining({ sessionId: "sess" }),
    });
  });

  test("preserves an incompatible stored thinkingLevel without loading the catalog for unrelated patches", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => [
      catalogEntry("synthetic/plain", { reasoning: false }),
    ]);
    const entry = await patchOk({
      cfg: modelConfig("synthetic/plain"),
      mainEntry: { thinkingLevel: "max" },
      label: "new label",
      loadGatewayModelCatalog,
    });

    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    expect(entry).toMatchObject({ label: "new label", thinkingLevel: "max" });
  });

  test.each([
    {
      field: "completionOwnerSessionKey",
      value: "agent:main:main",
      replacement: "agent:main:discord:direct:bob",
      error: "completionOwnerSessionKey cannot be changed once set",
    },
    {
      field: "inheritedToolPolicyVersion",
      value: 1,
      replacement: null,
      error: "inheritedToolPolicyVersion cannot be cleared once set",
    },
  ] as const)(
    "sets immutable $field for ACP sessions",
    async ({ field, value, replacement, error }) => {
      const entry = await patchOk({ storeKey: "agent:main:acp:child", [field]: value });
      expect(entry[field]).toBe(value);

      const result = await runPatch({
        storeKey: "agent:main:acp:child",
        store: { "agent:main:acp:child": entry },
        [field]: replacement,
      });
      expectPatchError(result, error);
    },
  );

  test.each([
    { field: "inheritedToolDeny", input: ["bash", "read", "bash"], expected: ["exec", "read"] },
    {
      field: "inheritedToolAllow",
      input: ["sessions_spawn", "read", "sessions_spawn"],
      expected: ["sessions_spawn", "read"],
    },
  ] as const)("normalizes $field for ACP sessions", async ({ field, input, expected }) => {
    const entry = await patchOk({ storeKey: "agent:main:acp:child", [field]: [...input] });
    expect(entry[field]).toEqual(expected);
  });

  test("preserves inheritedToolDeny entries beyond large configured lists", async () => {
    const configuredDeny = Array.from({ length: 150 }, (_, index) => `custom_${index}`);
    const entry = await patchOk({
      storeKey: "agent:main:subagent:child",
      inheritedToolDeny: [...configuredDeny, "exec"],
    });
    expect(entry.inheritedToolDeny).toHaveLength(151);
    expect(entry.inheritedToolDeny?.at(-1)).toBe("exec");
  });

  test("normalizes exec/send/group patches", async () => {
    const entry = await patchOk({
      execHost: " AUTO ",
      execNode: " worker-1 ",
      sendPolicy: "DENY" as unknown as "allow",
      groupActivation: "Always" as unknown as "mention",
    });
    expect(entry.execHost).toBe("auto");
    expect(entry.execNode).toBe("worker-1");
    expect(entry.sendPolicy).toBe("deny");
    expect(entry.groupActivation).toBe("always");
  });

  test("stores and clears the session permission mode", async () => {
    const stored = await patchOk({
      mainEntry: { sessionRoot: "/workspace/project" },
      permissionMode: "workspace",
    });
    expect(stored.permissionMode).toBe("workspace");
    expect(stored.sessionRoot).toBe("/workspace/project");

    const cleared = await patchOk({ store: { [MAIN_SESSION_KEY]: stored }, permissionMode: null });
    expect(cleared.permissionMode).toBeUndefined();
    expect(cleared.sessionRoot).toBe("/workspace/project");
  });

  test.each([{ execSecurity: null }, { execAsk: "always" }])(
    "rejects retired session policy patch %j without writing",
    async (retiredPatch) => {
      for (const store of [
        {},
        mainStoreEntry({ label: "Original", permissionMode: "read-only" }),
      ]) {
        const before = structuredClone(store);
        const result = await runPatch({
          store,
          label: "Changed",
          permissionMode: "guarded",
          ...retiredPatch,
        });

        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message:
              "execSecurity/execAsk are retired; set permissionMode (read-only|guarded|workspace|full) instead, or use /exec for this run only.",
          },
        });
        expect(store).toEqual(before);
      }
    },
  );

  test.each([
    { host: "node", node: "worker-2", expectedHost: "node", expectedNode: "worker-2" },
    { host: "node", node: null, expectedHost: undefined, expectedNode: undefined },
    { host: "gateway", node: null, expectedHost: "gateway", expectedNode: undefined },
  ] as const)(
    "clears node cwd when $host binding changes to $node",
    async ({ host, node, expectedHost, expectedNode }) => {
      const store = mainStoreEntry({
        execHost: host,
        execNode: "worker-1",
        execCwd: "/workspace/on-worker-1",
      });
      const changed = await patchOk({ store, execNode: node });
      expect(changed.execNode).toBe(expectedNode);
      expect(changed.execCwd).toBeUndefined();
      expect(changed.execHost).toBe(expectedHost);
    },
  );

  test.each(
    [
      { source: "target agent primary", agentPrimaryModel: SUBAGENT_MODEL },
      {
        source: "target agent subagents.model",
        agentPrimaryModel: ANTHROPIC_SONNET_MODEL,
        agentSubagentModel: SUBAGENT_MODEL,
      },
      { source: "global subagents.model", defaultsSubagentModel: SUBAGENT_MODEL },
    ].flatMap((config) => [
      { ...config, allowModel: false },
      { ...config, allowModel: true },
    ]),
  )("requires manual permission for $source (allowed: $allowModel)", async (config) => {
    const cfg = makeKimiSubagentCfg(config);
    const store: Record<string, SessionEntry> = {
      [KIMI_SUBAGENT_KEY]: {
        sessionId: "subagent-policy",
        updatedAt: 1,
        delivery: { kind: "none" },
      },
    };
    const before = structuredClone(store);
    const result = await applySubagentModelPatch(cfg, store);
    if (!config.allowModel) {
      expectPatchError(result, "model not allowed");
      expect(store).toEqual(before);
      return;
    }
    const entry = expectPatchOk(result);
    if (config.agentPrimaryModel === SUBAGENT_MODEL) {
      expectModelSelection(entry, undefined, undefined);
      expect(entry.modelOverrideSource).toBe("default");
      expect(entry.modelOverrideRouteResolution).toBeUndefined();
    } else {
      expectModelSelection(entry, "synthetic", "hf:moonshotai/Kimi-K2.7-Code");
      expect(entry.modelOverrideSource).toBe("user");
    }
  });

  test.each([
    { profile: "newprofile", existing: true },
    { profile: "openai:user@example.com", existing: false },
  ])("persists @profile=$profile (existing=$existing)", async ({ profile, existing }) => {
    const store = existing
      ? mainStoreEntry({
          sessionId: "sess-live-profile-only",
          providerOverride: "anthropic",
          modelOverride: ANTHROPIC_SONNET_ID,
          authProfileOverride: "oldprofile",
          authProfileOverrideSource: "user",
        })
      : undefined;
    const entry = await applyMainModelPatch({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      model: `${ANTHROPIC_SONNET_MODEL}@${profile}`,
      catalogRefs: [ANTHROPIC_SONNET_MODEL],
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expectAuthOverride(entry, { profile });
    if (existing) {
      expect(entry.liveModelSwitchPending).toBe(true);
    }
  });

  test("resolves bare allowlisted model ids before persisting @profile suffix", async () => {
    const entry = await patchOk({
      cfg: modelConfig("openai/gpt-5.4", {
        models: {
          "opencode-go/kimi-k2.6": {},
        },
      }),
      model: "kimi-k2.6@work",
      loadGatewayModelCatalog: loadCatalog(OPENAI_GPT_MODEL, "opencode-go/kimi-k2.6"),
    });
    expect(entry.providerOverride).toBe("opencode-go");
    expect(entry.modelOverride).toBe("kimi-k2.6");
    expect(entry.authProfileOverride).toBe("work");
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
