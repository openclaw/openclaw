import fs from "node:fs";
// Session utility tests cover key parsing, store migration, agent/default rows,
// model identity resolution, title derivation, and byte-capped row payloads.
import "./session-utils-provider.test-support.js";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { resolveLegacyInheritedAuthAgentId } from "../agents/legacy-inherited-auth-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import {
  listSessionChildEntriesReadOnly,
  listSessionEntriesReadOnly,
  recordInboundSessionMeta,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { CronJob } from "../cron/types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import * as execApprovalsStore from "../infra/exec-approvals-store.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";
import { registerSessionAutomationSource } from "./session-automation-index.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { projectSessionActor } from "./session-identity-projection.js";
import { buildSessionRowFixture, listSessionFixture } from "./session-list.test-support.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";
import { deriveSessionTitle } from "./session-utils-core.js";
import {
  getSessionDefaults,
  projectSessionPatchResult,
  resolveGatewayModelSupportsImages,
} from "./session-utils-model.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { buildGatewaySessionRow as buildGatewaySessionRowOwner } from "./session-utils-row.js";
import { resolveGatewaySessionStoreTargetWithStoreAsync } from "./session-utils-store-lookup.js";
import {
  loadGatewaySessionEntryReadOnlyInWorker,
  resolveGatewaySessionStoreTargetInWorker,
} from "./session-utils-store-worker.js";
import {
  listAgentsForGateway,
  loadGatewaySessionEntryReadOnlyAsync,
} from "./session-utils-store.js";
import { withAgentPermissionState } from "./session-utils.permissions.test-support.js";
import {
  closeSessionSqliteDatabasesForTest,
  createModelDefaultsConfig,
  createSingleAgentAvatarConfig,
  seedSessionEntries,
  useSessionStoreFixture,
  withStateDirEnv,
} from "./session-utils.test-support.js";
import { applySessionContextWindowPatch } from "./sessions-patch-context-window.js";

const { getSessionProviderArtifactMocks, resetSessionProviderArtifacts } =
  await import("./session-utils-provider.test-support.js");
const providerArtifactMocks = getSessionProviderArtifactMocks();

function makeSession(sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: 1, ...fields };
}

function storeConfig(
  store: string,
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = { main: {} },
): OpenClawConfig {
  return { session: { mainKey: "main", store }, agents: { entries } };
}

const agentStore = (root: string, agentId = "{agentId}") =>
  path.join(root, "agents", agentId, "sessions", "sessions.json");

function seedDeletedMainStores(stateDir: string, mainKey = "main") {
  const deletedStorePath = agentStore(stateDir, "main");
  const liveStorePath = agentStore(stateDir, "ops");
  for (const storePath of [liveStorePath, deletedStorePath]) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
  }
  seedSessionEntries(liveStorePath, {
    [`agent:ops:${mainKey}`]: makeSession("sess-live-default", { updatedAt: 10 }),
  });
  seedSessionEntries(deletedStorePath, {
    "agent:main:main": makeSession("sess-deleted-main", { updatedAt: 20 }),
  });
  return { deletedStorePath, storeTemplate: agentStore(stateDir) };
}

function catalogModel(
  provider: string,
  id: string,
  fields: Partial<GatewayModelCatalogSnapshot["entries"][number]> = {},
) {
  return { provider, id, name: id, ...fields };
}

const mainAgentConfig: OpenClawConfig = { agents: { entries: { main: {} } } };

function imessageEntry(chatType: "direct" | "group", to: string, label: string, from = to) {
  return {
    chatType,
    delivery: normalizeSessionDeliveryState({
      context: { channel: "imessage", to },
      origin: { provider: "imessage", label, from },
    }),
  };
}
function slackChannelEntry(): Partial<SessionEntry> {
  return {
    chatType: "channel",
    groupChannel: "general",
    space: "Acme",
    delivery: normalizeSessionDeliveryState({ context: { channel: "slack", to: "channel:C1" } }),
  };
}

function installConfig(cfg: OpenClawConfig) {
  setRuntimeConfigSnapshot(cfg);
  onTestFinished(() => resetConfigRuntimeState());
}

function listSessions(
  cfg: OpenClawConfig,
  store: Record<string, SessionEntry>,
  opts: Parameters<typeof listSessionFixture>[0]["opts"],
) {
  return listSessionFixture({ cfg, store, opts, storePath: "" });
}

test("resolves fixed-store and auth owners independently of retained Doctor ownership", () => {
  const cfg = retainLegacyDefaultAgentId(
    {
      agents: {
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "ops" },
          sessionStore: { agentId: "   " },
        },
        entries: { ops: {}, research: {} },
      },
      session: { mainKey: "work", store: "/tmp/openclaw-fixed-sessions.json" },
    } satisfies OpenClawConfig,
    "ops",
  );
  expect(resolveSessionStoreKey({ cfg, sessionKey: "incident-42" })).toBe("agent:ops:incident-42");
  const explicit = { agents: { ownership: "explicit" as const, entries: { a: {}, b: {} } } };
  expect(() =>
    resolveSessionStoreKey({
      cfg: retainLegacyDefaultAgentId({ ...explicit }, "a"),
      sessionKey: "incident-42",
    }),
  ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  expect(
    resolveLegacyInheritedAuthAgentId({
      ...explicit,
      agents: { ...explicit.agents, defaults: { authInheritance: { agentId: "saved" } } },
    }),
  ).toBe("saved");
  expect(resolveLegacyInheritedAuthAgentId(explicit)).toBe("main");
  expect(resolveLegacyInheritedAuthAgentId(retainLegacyDefaultAgentId(explicit, "a"))).toBe("main");
  expect(resolveLegacyInheritedAuthAgentId({ agents: { entries: { solo: {} } } })).toBe("solo");
});

test("projects a channel avatar route without exposing its media-store reference", () => {
  const key = "agent:main:discord:direct:user-1";
  const localReference = "/private/state/media/inbound/avatar.png";
  const cfg = {
    gateway: { controlUi: { basePath: "/control" } },
  } as OpenClawConfig;
  const avatarEntry = (avatar: string): SessionEntry => ({
    ...makeSession("avatar-session"),
    delivery: normalizeSessionDeliveryState({
      context: { channel: "discord", to: "user:user-1" },
      origin: { provider: "discord", to: "user:user-1", avatar },
    }),
  });
  const readRow = (entry: SessionEntry) =>
    buildGatewaySessionRowOwner({
      cfg,
      agentId: "main",
      storePath: "",
      store: { [key]: entry },
      key,
      entry,
    });
  const row = readRow(avatarEntry(localReference));

  expect(row.channelAvatarUrl).toMatch(
    /^\/control\/__openclaw__\/channel-avatar\/agent%3Amain%3Adiscord%3Adirect%3Auser-1\?v=[A-Za-z0-9_-]{12}$/,
  );
  expect(row.origin).toEqual({ provider: "discord", to: "user:user-1" });
  expect(JSON.stringify(row)).not.toContain(localReference);
  expect(buildGatewaySessionSnapshot({ sessionRow: row })).toMatchObject({
    channelAvatarUrl: row.channelAvatarUrl,
  });

  // A changed backing reference must invalidate browser blob/404 caches.
  const replacedRow = readRow(avatarEntry("/private/state/media/inbound/avatar-2.png"));
  expect(replacedRow.channelAvatarUrl).toBeDefined();
  expect(replacedRow.channelAvatarUrl).not.toBe(row.channelAvatarUrl);
});

function createSymlinkOrSkip(targetPath: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(targetPath, linkPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      return false;
    }
    throw error;
  }
}

async function withConfiguredStateDir(
  prefix: string,
  run: (ctx: { tempRoot: string; stateDir: string }) => Promise<void>,
) {
  resetConfigRuntimeState();
  try {
    await withStateDirEnv(prefix, run);
  } finally {
    resetConfigRuntimeState();
  }
}

type SessionRowFixtureParams = Parameters<typeof buildSessionRowFixture>[0];

function buildGatewaySessionRow(
  params: Omit<SessionRowFixtureParams, "storePath" | "store" | "key"> &
    Partial<Pick<SessionRowFixtureParams, "storePath" | "store" | "key">>,
): ReturnType<typeof buildGatewaySessionRowOwner> {
  const entry = params.entry ?? ({} as SessionEntry);
  const rowContext = buildSessionListRowMetadataContext({
    now: params.now ?? Date.now(),
  });
  return buildSessionRowFixture({
    storePath: "",
    store: {},
    key: "agent:main:main",
    ...params,
    entry,
    rowContext,
    lightweightListRow: params.lightweightListRow ?? true,
  });
}

function setTestActivePluginRegistry(
  registry: Parameters<typeof setActivePluginRegistry>[0],
): void {
  setActivePluginRegistry(registry);
  onTestFinished(resetPluginRuntimeStateForTest);
}

describe("gateway session utils", () => {
  test("projects configured agent identity while tolerating legacy session-key actor ids", () => {
    const cfg = {
      agents: {
        entries: { roboclaw: { identity: { name: "Roboclaw", avatar: "avatar.png" } } },
      },
      gateway: { controlUi: { basePath: "/control" } },
    } as OpenClawConfig;

    expect(projectSessionActor({ type: "agent", id: "roboclaw" }, new Map(), cfg)).toEqual({
      type: "agent",
      id: "roboclaw",
      identity: { type: "agent", id: "roboclaw" },
      label: "Roboclaw",
      avatarUrl: "/control/avatar/roboclaw",
    });
    expect(
      projectSessionActor(
        { type: "agent", id: "agent:roboclaw:discord:channel:123" },
        new Map(),
        cfg,
      ),
    ).toEqual({
      type: "agent",
      id: "agent:roboclaw:discord:channel:123",
      identity: { type: "agent", id: "agent:roboclaw:discord:channel:123" },
    });
  });

  beforeEach(resetSessionProviderArtifacts);

  afterAll(closeSessionSqliteDatabasesForTest);

  test.each([false, true])("projects only an active fallback model (recovered=%s)", (recovered) => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({
        primary: recovered ? "codex/gpt-5.5" : "ollama/qwen3.5:9b",
      }),
      key: "main",
      entry: {
        sessionId: "fallback-session",
        updatedAt: 1,
        ...(!recovered ? { providerOverride: "codex", modelOverride: "gpt-5.5" } : {}),
        modelProvider: recovered ? "codex" : "ollama",
        model: recovered ? "gpt-5.5" : "qwen3.5:9b",
        fallbackNotice: {
          kind: "active",
          selectedModel: "codex/gpt-5.5",
          activeModel: "ollama/qwen3.5:9b",
        },
      },
    });

    expect(row).toMatchObject({
      modelProvider: "codex",
      model: "gpt-5.5",
      activeModelProvider: recovered ? undefined : "ollama",
      activeModel: recovered ? undefined : "qwen3.5:9b",
    });
  });

  test("projects a running candidate across aliased keys without changing the configured model", () => {
    const runId = "live-model-projection";
    const context = {
      agentId: "main",
      sessionKey: "agent:main:canonical",
      sessionId: "live-model-session",
      activeModel: { provider: "ollama", model: "qwen3.5:9b" },
    };
    registerAgentRunContext(runId, context);
    onTestFinished(() => clearAgentRunContext(runId));
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "anthropic/claude-sonnet-4-6" }),
      key: "main",
      entry: {
        sessionId: context.sessionId,
        updatedAt: 1,
        lastRunId: runId,
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });
    expect(row).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      activeModelProvider: "ollama",
      activeModel: "qwen3.5:9b",
    });
  });

  test("projects restart recovery tombstones", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      key: "agent:main:dashboard:tombstoned",
      entry: {
        sessionId: "session-tombstoned",
        updatedAt: 1,
        mainRestartRecovery: {
          cycleId: "cycle-tombstoned",
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      } as SessionEntry,
    });

    expect(row.restartRecoveryStatus).toBe("tombstoned");
    expect(buildGatewaySessionSnapshot({ sessionRow: row }).restartRecoveryStatus).toBe(
      "tombstoned",
    );
  });

  test("projects the compact persisted observer digest", () => {
    const expected = {
      runId: "run-1",
      revision: 3,
      updatedAt: 2_000,
      headline: "Wrapping up the implementation",
      health: "wrapping-up" as const,
    };
    const observerDigest = {
      ...expected,
      sessionKey: "agent:main:main",
      assessment: "The focused tests pass.",
      planProgress: { completed: 3, total: 4 },
    };
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      entry: { sessionId: "session", updatedAt: 1, observerDigest },
    });

    expect(row.observerDigest).toEqual(expected);
    expect(buildGatewaySessionSnapshot({ sessionRow: row }).observerDigest).toEqual(
      row.observerDigest,
    );
  });

  test("Activity lists select newest interactions and completions before the 100-row page", async () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    installConfig(cfg);
    const now = Date.now();
    const store: Record<string, SessionEntry> = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `session-${index}`,
        makeSession(`session-${index}`, {
          updatedAt: now - index,
          lastActivityAt: now - 10_000 - index,
          ...(index === 0 ? { pinnedAt: now } : {}),
        }),
      ]),
    );
    store["new-completion"] = makeSession("new-completion", {
      updatedAt: now - 100_000,
      lastActivityAt: now - 1,
      lastInteractionAt: now - 200_000,
    });
    store["new-input"] = makeSession("new-input", {
      updatedAt: now - 200_000,
      lastActivityAt: now - 200_000,
      lastInteractionAt: now,
    });
    const original = structuredClone(store);
    const firstPage = await listSessions(cfg, store, { sortBy: "activity" });
    expect(firstPage.sessions.map((row) => row.key)).toEqual([
      "new-input",
      "new-completion",
      ...Array.from({ length: 98 }, (_, index) => `session-${index}`),
    ]);
    expect(firstPage).toMatchObject({ totalCount: 103, nextOffset: 100, hasMore: true });
    const lastPage = await listSessions(cfg, store, {
      sortBy: "activity",
      offset: firstPage.nextOffset ?? 0,
    });
    expect(lastPage.sessions.map((row) => row.key)).toEqual([
      "session-98",
      "session-99",
      "session-100",
    ]);
    expect(lastPage).toMatchObject({ totalCount: 103, nextOffset: null, hasMore: false });
    expect(store).toEqual(original);
    expect(Object.keys(store)).toEqual(Object.keys(original));
  });

  test("Activity time filters use activity age without changing ordinary metadata filters", async () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    installConfig(cfg);
    const now = 1_800_000_000_000;
    const cutoff = now - 60 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    onTestFinished(() => clock.mockRestore());
    const store: Record<string, SessionEntry> = {
      "new-input": makeSession("new-input", {
        updatedAt: cutoff - 1,
        lastActivityAt: cutoff - 1,
        lastInteractionAt: now,
      }),
      "boundary-completion": makeSession("boundary-completion", {
        updatedAt: cutoff - 1,
        lastActivityAt: cutoff,
      }),
      "metadata-only-update": makeSession("metadata-only-update", {
        updatedAt: now,
        lastActivityAt: cutoff - 1,
        lastInteractionAt: cutoff - 2,
      }),
      "legacy-boundary": { sessionId: "legacy-boundary", updatedAt: cutoff },
      "old-session": { sessionId: "old-session", updatedAt: cutoff - 1 },
    };
    const activity = await listSessions(cfg, store, { sortBy: "activity", activeMinutes: 60 });
    expect(activity.sessions.map((row) => row.key)).toEqual([
      "new-input",
      "boundary-completion",
      "legacy-boundary",
    ]);
    expect(activity.totalCount).toBe(3);
    const ordinary = await listSessions(cfg, store, { activeMinutes: 60 });
    expect(ordinary.sessions.map((row) => row.key)).toEqual([
      "metadata-only-update",
      "legacy-boundary",
    ]);
  });

  test("session lists page from an offset after filtering and sorting", async () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    installConfig(cfg);
    const store = Object.fromEntries(
      Array.from({ length: 6 }, (_value, index) => [
        `session-${index}`,
        makeSession(`session-${index}`, {
          updatedAt: 1_000 - index,
          displayName: index === 5 ? "Different project" : `Project Alpha ${index}`,
        }),
      ]),
    );

    const listed = await listSessions(cfg, store, { search: "alpha", limit: 2, offset: 2 });

    expect(listed.sessions.map((session) => session.key)).toEqual(["session-2", "session-3"]);
    expect(listed).toMatchObject({
      count: 2,
      totalCount: 5,
      limitApplied: 2,
      offset: 2,
      nextOffset: 4,
      hasMore: true,
    });
  });

  test("session defaults and rows use the concrete runtime thinking policy", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers = ["anthropic", "claude-cli"].map(
      (id): (typeof registry.providers)[number] => ({
        pluginId: "anthropic",
        source: "test",
        provider: {
          id,
          label: id,
          auth: [],
          resolveThinkingProfile: () =>
            id === "anthropic"
              ? {
                  levels: [{ id: "minimal" }, { id: "medium" }, { id: "adaptive" }],
                  defaultLevel: "adaptive",
                  preserveWhenCatalogReasoningFalse: true,
                }
              : { levels: [{ id: "off" }], defaultLevel: "off" },
        },
      }),
    );
    setTestActivePluginRegistry(registry);

    const cfg = createModelDefaultsConfig({ primary: "anthropic/claude-mythos-5" });
    const catalog = [
      catalogModel("anthropic", "claude-mythos-5", {
        name: "Claude Mythos 5",
        reasoning: false,
        thinkingPolicyProvider: "claude-cli",
      }),
    ];

    const defaults = getSessionDefaults(cfg, catalog);
    const row = buildGatewaySessionRow({
      cfg,
      key: "main",
      modelCatalog: catalog,
    });

    for (const value of [defaults, row]) {
      expect(value.thinkingLevels?.map((level) => level.id)).toEqual(["off", "ultra"]);
      expect(value.thinkingDefault).toBe("off");
    }
  });

  test("session rows project the selected catalog context window", () => {
    const catalog = [
      catalogModel("window-fixture", "selectable-model", {
        name: "Selectable Model",
        contextWindow: 1_000_000,
        contextWindows: [
          { id: "200k", label: "200K", contextWindow: 200_000 },
          { id: "1m", label: "1M", contextWindow: 1_000_000 },
        ],
        contextWindowDefault: "1m",
      }),
    ];
    const cfg = createModelDefaultsConfig({ primary: "window-fixture/selectable-model" });

    const defaults = getSessionDefaults(cfg, catalog);
    const row = buildGatewaySessionRow({
      cfg,
      entry: { sessionId: "ctx", contextWindow: "200k" } as SessionEntry,
      modelCatalog: catalog,
    });

    expect(defaults).toMatchObject({ contextWindow: "1m", contextTokens: 1_000_000 });
    expect(row).toMatchObject({ contextWindow: "200k", contextTokens: 200_000 });
    expect(row.contextWindows).toEqual(catalog[0]?.contextWindows);
  });

  test.each([{ before: 128_000, after: 32_000, reserve: 20_000 }])(
    "projects the new cap immediately after a $before → $after context selection",
    ({ before, after, reserve }) => {
      const catalog = [
        catalogModel("ollama", "qwen3:8b", {
          name: "Qwen",
          contextWindow: 128_000,
          api: "ollama" as const,
          contextWindows: [
            { id: "32000", label: "32K", contextWindow: 32_000 },
            { id: "128000", label: "128K", contextWindow: 128_000 },
          ],
        }),
      ];
      const cfg = createModelDefaultsConfig({
        primary: "ollama/qwen3:8b",
        agentRuntime: { id: "openclaw" },
      });
      const entry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "qwen3:8b",
        agentHarnessId: "openclaw",
        contextWindow: String(before),
        contextTokens: before,
        contextTokensSource: "runtime",
        contextBudgetStatus: contextBudgetStatusFixture({
          contextTokenBudget: before,
          promptBudgetBeforeReserve: before - reserve,
          reserveTokens: reserve,
          effectiveReserveTokens: reserve,
          estimatedPromptTokens: 1_000,
          remainingPromptBudgetTokens: before - reserve - 1_000,
        }),
      };
      const previousRow = buildGatewaySessionRow({
        cfg,
        entry,
        modelCatalog: catalog,
      });
      expect(previousRow.contextTokens).toBe(before);
      expect(previousRow.agentRuntime?.id).toBe(entry.agentHarnessId);
      const patch = applySessionContextWindowPatch({
        next: entry,
        patch: { key: "agent:main:main", contextWindow: String(after) },
        defaultProvider: "ollama",
        defaultModel: "qwen3:8b",
        runtimeId: () => "openclaw",
        routeVariants: () => catalog,
        *loadModelCatalog() {
          yield;
          return catalog;
        },
      });
      patch.next();
      expect(patch.next().value).toEqual({ ok: true });
      const row = buildGatewaySessionRow({
        cfg,
        entry,
        modelCatalog: catalog,
      });
      expect(row.contextTokens).toBe(after);
      expect(row.contextBudgetStatus).toBeUndefined();
    },
  );

  test("session rows project automation bindings and event fields forward them", () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    registerSessionAutomationSource({
      getJobs: () => [{ id: "job1", enabled: true, sessionTarget: "isolated" } as CronJob],
      getDefaultAgentId: () => "main",
    });
    try {
      const bound = buildGatewaySessionRow({
        cfg,
        key: "agent:main:cron:job1",
        lightweightListRow: true,
      });
      expect(bound.hasAutomation).toBe(true);
      expect(buildGatewaySessionSnapshot({ sessionRow: bound }).hasAutomation).toBe(true);

      const plain = buildGatewaySessionRow({
        cfg,
        key: "agent:main:other",
        lightweightListRow: true,
      });
      expect(plain.hasAutomation).toBeUndefined();
      expect(buildGatewaySessionSnapshot({ sessionRow: plain }).hasAutomation).toBe(false);
    } finally {
      registerSessionAutomationSource(null);
    }
  });

  test("session list thinking cache preserves case-distinct model catalog entries", async () => {
    const cfg = createModelDefaultsConfig({ primary: "custom/CaseModel" });
    installConfig(cfg);
    const models = ["CaseModel", "casemodel"];
    const modelCatalog = models.map((id, index) =>
      catalogModel("custom", id, {
        reasoning: true,
        compat: {
          supportedReasoningEfforts: index
            ? ["low", "medium", "high"]
            : ["low", "medium", "high", "xhigh"],
        },
      }),
    );
    const result = await listSessionFixture({
      cfg,
      storePath: "",
      modelCatalog,
      store: Object.fromEntries(
        models.map((model, index) => {
          const key = index ? "lower" : "upper";
          return [
            key,
            makeSession(key, {
              providerOverride: "custom",
              modelOverride: model,
              modelProvider: "custom",
              model,
              updatedAt: 2 - index,
            }),
          ];
        }),
      ),
      opts: {},
    });

    const upper = result.sessions.find((session) => session.key === "upper");
    const lower = result.sessions.find((session) => session.key === "lower");
    expect(upper?.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(lower?.thinkingLevels?.map((level) => level.id)).not.toContain("xhigh");
  });

  test("session defaults and rows consume provider-policy thinking without catalog", () => {
    providerArtifactMocks.resolveBundledProviderPolicySurface.mockReturnValue({
      resolveThinkingProfile: () => ({
        levels: [
          { id: "off" },
          { id: "minimal" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "xhigh" },
        ],
      }),
    });
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.5" });

    const defaults = getSessionDefaults(cfg);
    const row = buildGatewaySessionRow({
      cfg,
      key: "main",
      lightweightListRow: false,
    });

    expect(defaults.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
    expect(row.thinkingLevels?.map((level) => level.id)).toContain("xhigh");
  });

  test("strips retired thinking provenance from Gateway patch results", () => {
    const entry = {
      ...makeSession("private-fallback"),
      thinkingLevelSelection: { retired: true },
      modelFallback: {
        prevModel: "gpt-5.6-sol",
        prevProvider: "openai",
        prevThinkingLevelSelection: { retired: true },
        source: "agent-patch",
        ts: 1,
      },
    } as unknown as InternalSessionEntry;
    const result = projectSessionPatchResult({
      preparedAcpMeta: null,
      canonicalKey: "agent:main:main",
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } },
      entry,
      modelCatalog: [
        catalogModel("openai", "gpt-5.6-sol", { name: "GPT 5.6 Sol", reasoning: true }),
      ],
      storePath: "/tmp/openclaw-sessions.json",
      targetAgentId: "main",
    });

    expect(result.entry.modelFallback).toEqual({
      prevModel: "gpt-5.6-sol",
      prevProvider: "openai",
      source: "agent-patch",
      ts: 1,
    });
    expect(JSON.stringify(result.entry)).not.toContain("thinkingLevelSelection");
  });

  test.each([false])(
    "projects the private native model instead of outer or observed guesses (lightweight=%s)",
    async (lightweightListRow) => {
      const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.6-sol" });
      installConfig(cfg);
      const entry = (sessionId: string): InternalSessionEntry => ({
        sessionId,
        updatedAt: 1,
        agentHarnessId: "test-native",
        modelSelectionLocked: true,
        modelProvider: "stale-provider",
        model: "stale-model",
      });
      const nativeKey = "agent:main:harness:test-native:native";
      const concreteKey = "agent:main:concrete";
      const native = entry("native-model-row");
      const concrete: InternalSessionEntry = {
        ...entry("concrete-model-row"),
        pluginOwnerId: "test-native",
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      };
      const store = {
        [nativeKey]: native,
        [concreteKey]: concrete,
      };
      let nativeBound = true;
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "test-native",
        source: "test",
        harness: {
          id: "test-native",
          label: "Native session model owner",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("session rows must not start a model turn");
          },
          resolveSessionRuntimeOwnership: (params) => {
            params.assertCurrent();
            return nativeBound &&
              params.sessionKey === nativeKey &&
              params.sessionId === native.sessionId
              ? {
                  model: "native" as const,
                  auth: "native" as const,
                  modelRef: { provider: "openai", model: "gpt-5.6-luna" },
                }
              : undefined;
          },
        },
      });
      setTestActivePluginRegistry(registry);
      const rowContext = buildSessionListRowMetadataContext({ now: 1 });
      const readRow = (key: keyof typeof store) =>
        buildGatewaySessionRowOwner({
          cfg,
          agentId: "main",
          storePath: "",
          store,
          key,
          entry: store[key],
          rowContext,
          lightweightListRow,
        });
      const nativeRow = readRow(nativeKey);
      expect(nativeRow).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-luna" });
      const matches = await listSessions(cfg, store, { search: "openai/gpt-5.6-luna" });
      expect(matches.sessions.map((row) => row.key)).toEqual([nativeKey]);
      expect(buildGatewaySessionSnapshot({ sessionRow: nativeRow })).toMatchObject({
        modelProvider: "openai",
        model: "gpt-5.6-luna",
      });
      expect(readRow(concreteKey)).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-sol" });
      expect(native.model).toBe("stale-model");
      nativeBound = false;
      expect(readRow(nativeKey)).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-sol" });
    },
  );

  test("session rows preserve fresh zero-token usage", () => {
    const row = buildGatewaySessionRow({
      cfg: {},
      entry: makeSession("fresh-zero-token-session", {
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    });
    expect(row).toMatchObject({ totalTokens: 0, totalTokensFresh: true });
  });

  test.each<[string, Partial<SessionEntry>, string | undefined]>([
    [
      "imessage:direct:+15551234567",
      imessageEntry("direct", "auto:+15551234567", "+15551234567"),
      undefined,
    ],
    ["imessage:direct:Alice", imessageEntry("direct", "imessage:Alice", "Alice"), "Alice"],
    [
      "imessage:group:13",
      {
        ...imessageEntry("group", "chat_id:13", "Group id:13", "imessage:group:13"),
        groupId: "13",
        displayName: "imessage:g-13",
      },
      undefined,
    ],
    ["slack:channel:C1", slackChannelEntry(), "Acme #general"],
    ["slack:channel:C1", { ...slackChannelEntry(), label: "Team room" }, "Team room"],
  ])("projects the display name of %s", (suffix, fields, expected) => {
    const key = `agent:main:${suffix}`;
    const entry = makeSession("display-name", fields);
    const row = buildGatewaySessionRow({
      cfg: mainAgentConfig,
      store: { [key]: entry },
      key,
      entry,
    });
    expect(row.displayName).toBe(expected);
  });

  test("refreshes forum topic titles without replacing sessions or explicit labels", async () => {
    await withStateDirEnv("openclaw-topic-session-title-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "sessions.json");
      const key = "agent:main:telegram:group:-1001234567890:topic:42";
      const siblingKey = "agent:main:telegram:group:-1001234567890:topic:43";
      const scope = (sessionKey = key) => ({ sessionKey, storePath });
      const readStore = () =>
        Object.fromEntries(
          listSessionEntriesReadOnly({ agentId: "main", storePath }).map(
            ({ sessionKey, entry }) => [sessionKey, entry] as const,
          ),
        );
      const readRow = (store: Record<string, SessionEntry>, sessionKey = key) =>
        buildGatewaySessionRow({
          cfg: mainAgentConfig,
          storePath,
          store,
          key: sessionKey,
          entry: store[sessionKey],
        });
      const update = (
        changes: Partial<Parameters<typeof recordInboundSessionMeta>[0]["ctx"]>,
        sessionKey = key,
      ) =>
        recordInboundSessionMeta({
          ...scope(sessionKey),
          ctx: {
            Provider: "telegram",
            Surface: "telegram",
            ChatType: "group",
            From: "telegram:group:-1001234567890:topic:42",
            To: "telegram:-1001234567890",
            GroupSubject: "Project Team",
            MessageThreadId: 42,
            IsForum: true,
            ...changes,
          },
        });
      for (const sessionKey of [key, siblingKey]) {
        await replaceSessionEntry(
          scope(sessionKey),
          makeSession(sessionKey, { chatType: "group", subject: "Project Team" }),
        );
      }
      await update(
        {
          From: "telegram:group:-1001234567890:topic:43",
          MessageThreadId: 43,
          TopicName: "Releases",
        },
        siblingKey,
      );
      for (const [TopicName, title] of [
        [undefined, "Project Team"],
        ["  ", "Project Team"],
        [" Planning ", "Project Team / Planning"],
        ["Planning", "Project Team / Planning"],
        ["Roadmap", "Project Team / Roadmap"],
      ]) {
        await update({ TopicName });
        await closeSessionSqliteDatabasesForTest();
        const store = readStore();
        expect(store[key]).toMatchObject({ sessionId: key, subject: "Project Team" });
        expect(readRow(store)).toMatchObject({ displayName: title, origin: { threadId: 42 } });
        expect(readRow(store, siblingKey).displayName).toBe("Project Team / Releases");
      }
      const previous = expectDefined(readStore()[key], "topic session before sparse update");
      await update({ GroupSubject: undefined });
      expect(readStore()[key]).toMatchObject({
        subject: previous.subject,
        displayName: previous.displayName,
        topicName: "Roadmap",
      });
      await replaceSessionEntry(scope(), { ...previous, label: "My planning chat" });
      await update({ TopicName: "Next" });
      expect(readRow(readStore()).displayName).toBe("My planning chat");
    });
  });
  test("buildGatewaySessionRow falls back to an opaque group token", () => {
    const key = "agent:main:telegram:group:99";
    const entry = makeSession("group-opaque", {
      chatType: "group",
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram", to: "group:99" } }),
    });
    expect(
      buildGatewaySessionRow({
        cfg: mainAgentConfig,
        key,
        entry,
        store: { [key]: entry },
      }).displayName,
    ).toMatch(/^telegram:/);
  });

  test("buildGatewaySessionRow projects the session root only for an explicit permission mode", () => {
    const row = (permissionMode?: "workspace") => {
      const name = permissionMode ? "permission" : "ordinary";
      const key = `agent:main:${name}`;
      const entry = makeSession(name, {
        sessionRoot: "/workspace/private",
        ...(permissionMode ? { permissionMode } : {}),
      });
      return buildGatewaySessionRow({ cfg: mainAgentConfig, entry, key, store: { [key]: entry } });
    };
    expect(row()).not.toHaveProperty("sessionRoot");
    expect(row("workspace")).toMatchObject({
      permissionMode: "workspace",
      sessionRoot: "/workspace/private",
    });
  });

  test.each(["ops", "retired"])(
    "resolves bare keys only for configured fixed-store owner %s",
    (owner) => {
      const cfg = {
        session: { mainKey: "main", store: "/tmp/shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: owner } },
          entries: { ops: {}, research: {} },
        },
      } as OpenClawConfig;
      if (owner === "ops") {
        expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:main");
        expect(resolveSessionStoreKey({ cfg, sessionKey: "thread-1" })).toBe("agent:ops:thread-1");
        expect(resolveSessionStoreAgentId(cfg, "global")).toBe("ops");
      } else {
        expect(() => resolveSessionStoreKey({ cfg, sessionKey: "thread-1" })).toThrowError(
          expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
        );
        expect(() => resolveSessionStoreAgentId(cfg, "global")).toThrowError(
          expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
        );
      }
    },
  );

  test("resolveSessionStoreKey honors global scope", async () => {
    const cfg = {
      session: { scope: "global", mainKey: "work" },
      agents: { entries: { ops: {} } },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("global");
    const target = await resolveGatewaySessionStoreTargetInWorker({
      cfg,
      key: "main",
      projection: "list",
      exactRead: true,
      readOnly: false,
    });
    expect(target.canonicalKey).toBe("global");
    expect(target.agentId).toBe("ops");
  });

  test.each(["fixed", "discovered", "cross-root", "legacy"] as const)(
    "keeps %s store paths and contents paired without provisioning legacy stores",
    async (layout) => {
      await withStateDirEnv("session-utils-store-layout-", async ({ stateDir, tempRoot }) => {
        const fixed = layout === "fixed";
        const agentId = fixed ? "ops" : layout === "cross-root" ? "old" : "retired-agent";
        const key = `agent:${agentId}:main`;
        const template =
          layout === "cross-root"
            ? path.join(
                tempRoot,
                "stores",
                "{agentId}",
                "agents",
                "{agentId}",
                "sessions",
                "sessions.json",
              )
            : agentStore(stateDir);
        const storePath = fixed
          ? path.join(stateDir, "configured", "sessions.json")
          : layout === "cross-root"
            ? template.replace("{agentId}", "work").replace("{agentId}", "old")
            : agentStore(stateDir, layout === "discovered" ? "Retired Agent" : agentId);
        const cfg = storeConfig(
          fixed ? storePath : template,
          fixed ? { ops: {} } : layout === "cross-root" ? { ops: {}, work: {} } : { main: {} },
        );
        const otherKey = `agent:${agentId}:other`;
        const records = { [layout === "discovered" ? otherKey : key]: makeSession("selected") };
        if (layout === "legacy") {
          fs.mkdirSync(path.dirname(storePath), { recursive: true });
          fs.writeFileSync(storePath, JSON.stringify(records), "utf8");
        } else {
          seedSessionEntries(storePath, records);
        }
        if (fixed) {
          seedSessionEntries(agentStore(stateDir, agentId), {
            [key]: makeSession("stale", { updatedAt: 99 }),
          });
        }
        const target = await resolveGatewaySessionStoreTargetWithStoreAsync({
          cfg,
          key,
          ...(layout === "discovered"
            ? { store: { [key]: makeSession("fallback", { updatedAt: 99 }) } }
            : {}),
        });
        expect(target.storePath).toBe(path.resolve(storePath));
        if (layout === "legacy") {
          expect(target.store).toEqual({});
          const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path;
          expect(sqlitePath).toBeDefined();
          expect(fs.existsSync(sqlitePath!)).toBe(false);
          expect(fs.readdirSync(path.dirname(storePath))).toEqual(["sessions.json"]);
        } else if (layout === "discovered") {
          expect(target.store[otherKey]?.sessionId).toBe("selected");
          expect(target.store).not.toHaveProperty(key);
        } else {
          expect(target.store[key]?.sessionId).toBe("selected");
        }
      });
    },
  );
  test("session targets preserve explicit sentinel owners and reject discovered collisions", async () => {
    await withStateDirEnv("session-utils-batch-owners-", async ({ stateDir }) => {
      const cfg = {
        session: { store: agentStore(stateDir) },
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig;
      for (const agentId of ["ops", "research"]) {
        await replaceSessionEntry(
          {
            agentId,
            sessionKey: "global",
            storePath: cfg.session.store.replaceAll("{agentId}", agentId),
          },
          makeSession(`global-${agentId}`),
        );
      }
      expect(
        await Promise.all(
          ["research", "ops"].map(
            async (agentId) =>
              await resolveGatewaySessionStoreTargetWithStoreAsync({
                cfg,
                key: "global",
                agentId,
                projection: "list",
                readOnly: true,
                exactRead: true,
              }),
          ),
        ),
      ).toMatchObject([
        { agentId: "research", store: { global: { sessionId: "global-research" } } },
        { agentId: "ops", store: { global: { sessionId: "global-ops" } } },
      ]);
      for (const directory of ["Retired Agent", "retired-agent"]) {
        seedSessionEntries(path.join(stateDir, "agents", directory, "sessions", "sessions.json"), {
          "agent:retired-agent:main": { sessionId: directory, updatedAt: 1 },
        });
      }
      const key = "agent:retired-agent:main";
      await expect(
        resolveGatewaySessionStoreTargetWithStoreAsync({
          cfg,
          key,
          readOnly: true,
          exactRead: true,
        }),
      ).rejects.toThrow("openclaw doctor --fix");
    });
  });

  test("loadGatewaySessionEntryReadOnly does not materialize a missing configured agent", async () => {
    await withConfiguredStateDir("session-utils-load-entry-read-only-", async ({ stateDir }) => {
      const cfg = storeConfig(agentStore(stateDir), { main: {}, missing: {} });
      setRuntimeConfigSnapshot(cfg, cfg);

      const loaded = await loadGatewaySessionEntryReadOnlyAsync("agent:missing:main");

      expect(loaded.entry).toBeUndefined();
      expect(fs.existsSync(path.join(stateDir, "agents", "missing"))).toBe(false);
    });
  });

  test("loadGatewaySessionEntryReadOnly reads changed rows after an in-process write", async () => {
    await withConfiguredStateDir("session-utils-request-discovery-", async ({ stateDir }) => {
      const storePath = agentStore(stateDir, "main");
      const cfg = storeConfig(storePath, { main: {} });
      const sessionKey = "agent:main:main";
      seedSessionEntries(storePath, {
        [sessionKey]: makeSession("session-before"),
      });
      setRuntimeConfigSnapshot(cfg, cfg);
      const first = await loadGatewaySessionEntryReadOnlyAsync(sessionKey);
      await replaceSessionEntry(
        { sessionKey, storePath },
        makeSession("session-after", { updatedAt: 2 }),
      );
      const second = await loadGatewaySessionEntryReadOnlyAsync(sessionKey);

      expect(first.entry?.sessionId).toBe("session-before");
      expect(second.entry?.sessionId).toBe("session-after");
    });
  });

  test("worker history reads only the selected row and direct children", async () => {
    await withConfiguredStateDir("session-utils-exact-read-only-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const cfg = {
        session: { mainKey: "main", store: storePath },
        agents: { entries: { main: {} } },
      } as OpenClawConfig;
      const parentKey = "agent:main:main";
      const childKey = "agent:main:child";
      const now = Date.now();
      seedSessionEntries(storePath, {
        [parentKey]: { sessionId: "parent", updatedAt: now },
        [childKey]: { sessionId: "child", spawnedBy: parentKey, updatedAt: now + 1 },
        ...Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [
            `agent:main:unrelated-${index}`,
            { sessionId: `unrelated-${index}`, updatedAt: now + index + 2 },
          ]),
        ),
      });
      setRuntimeConfigSnapshot(cfg, cfg);
      expect(
        listSessionEntriesReadOnly({ agentId: "main", storePath }).map((item) => item.sessionKey),
      ).toContain(childKey);
      expect(
        (await loadGatewaySessionEntryReadOnlyAsync(childKey, { clone: false })).entry,
      ).toMatchObject({
        sessionId: "child",
        spawnedBy: parentKey,
      });
      expect(
        (
          await listSessionChildEntriesReadOnly({
            agentId: "main",
            clone: false,
            sessionKey: parentKey,
            storePath,
          })
        ).map((item) => item.sessionKey),
      ).toEqual([childKey]);
      const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg,
        key: "main",
        includeStoreChildEntries: true,
      });

      expect(loaded.entry?.sessionId).toBe("parent");
      expect(Object.keys(loaded.store).toSorted()).toEqual([childKey, parentKey]);
    });
  });

  test.each(["research"])(
    "keeps private deleted-main discovery ahead of replacement selection (%s)",
    async (agentId) => {
      resetConfigRuntimeState();
      try {
        await withStateDirEnv("session-utils-load-deleted-main-entry-", async ({ stateDir }) => {
          const { storeTemplate, deletedStorePath } = seedDeletedMainStores(stateDir);
          const cfg = {
            session: { store: storeTemplate },
            agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
          } as OpenClawConfig;
          setRuntimeConfigSnapshot(cfg, cfg);

          const loaded = await loadSessionEntryAsync("agent:main:main", { agentId });
          expect(loaded.canonicalKey).toBe("agent:main:main");
          expect(loaded.storePath).toBe(path.resolve(deletedStorePath));
          expect(loaded.entry?.sessionId).toBe("sess-deleted-main");
        });
      } finally {
        resetConfigRuntimeState();
      }
    },
  );

  test.each([false, true])(
    "keeps deleted-main incognito lookups in their process store (exactRead=%s)",
    async (exactRead) => {
      await withStateDirEnv("session-utils-deleted-main-incognito-", async ({ stateDir }) => {
        const storePath = agentStore(stateDir, "main");
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        const key = "agent:main:dashboard:incognito-retired-owner";
        seedSessionEntries(storePath, {
          "agent:main:main": makeSession("durable-main"),
        });
        await replaceSessionEntry(
          { agentId: "main", sessionKey: key, storePath },
          { sessionId: "incognito-owner", updatedAt: 1, incognito: true },
        );
        const cfg = {
          session: {
            store: agentStore(stateDir),
          },
          agents: { entries: { ops: {} } },
        } as OpenClawConfig;
        for (const requestedKey of [key, "agent:main:dashboard:incognito-missing"]) {
          const target = await resolveGatewaySessionStoreTargetWithStoreAsync({
            cfg,
            key: requestedKey,
            readOnly: true,
            exactRead,
          });
          expect(target.storePath).toBe(
            resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
          );
          expect(target.storeKeys).toEqual([requestedKey]);
          expect(target.store[requestedKey]?.sessionId).toBe(
            requestedKey === key ? "incognito-owner" : undefined,
          );
          expect(target.store["agent:main:main"]).toBeUndefined();
        }
      });
    },
  );

  test("loadSessionEntry rejects deleted main aliases when mainKey is customized", async () => {
    await withConfiguredStateDir("session-utils-load-deleted-main-alias-", async ({ stateDir }) => {
      const { storeTemplate } = seedDeletedMainStores(stateDir, "work");
      const cfg = {
        session: { mainKey: "work", store: storeTemplate },
        agents: { entries: { ops: {} } },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      await expect(loadSessionEntryAsync("agent:main:work")).rejects.toThrow(
        "openclaw doctor --fix",
      );
    });
  });

  test("session store target preparation rejects legacy aliases", async () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { entries: { ops: {} } },
    } as OpenClawConfig;
    const store: Record<string, SessionEntry> = {
      "agent:ops:work": makeSession("sess-stale"),
      "agent:ops:main": makeSession("sess-fresh", { updatedAt: 2 }),
    };

    await expect(
      resolveGatewaySessionStoreTargetWithStoreAsync({
        cfg,
        key: "agent:ops:main",
        store,
      }),
    ).rejects.toThrow("openclaw doctor --fix");
  });

  test("listAgentsForGateway rejects avatar symlink escapes outside workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-outside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const outsideFile = path.join(root, "outside.txt");
    fs.writeFileSync(outsideFile, "top-secret", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(outsideFile, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = await listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBeUndefined();
  });

  test.each(["local", "data"])("keeps %s avatar bytes out of browser agent rows", async (kind) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-browser-avatar-"));
    onTestFinished(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const dataUrl = `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`;
    fs.writeFileSync(path.join(workspace, "avatar-link.png"), "avatar");
    const cfg = createSingleAgentAvatarConfig(workspace);
    if (kind === "data") {
      cfg.agents!.entries!.main!.identity!.avatar = dataUrl;
    }
    const browser = await listAgentsForGateway(cfg, { httpAvatarBasePath: "/control" });
    expect(browser.agents[0]?.identity?.avatarUrl).toMatch(
      /^\/control\/avatar\/main\?v=[a-f0-9]+$/,
    );
    expect(browser.agents[0]?.identity?.avatar).toBe(browser.agents[0]?.identity?.avatarUrl);
    expect(JSON.stringify(browser)).not.toContain(dataUrl);
    expect((await listAgentsForGateway(cfg)).agents[0]?.identity?.avatarUrl).toBe(dataUrl);
  });

  test("listAgentsForGateway preserves canonical roster kinds", async () => {
    await withStateDirEnv("openclaw-agent-list-kinds-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "openclaw"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "research"), { recursive: true });

      const result = await listAgentsForGateway({}, { includeSystem: true });

      expect(result.agents.map(({ id, kind }) => ({ id, kind }))).toEqual([
        { id: "main", kind: "agent" },
        { id: "openclaw", kind: "system" },
        { id: "research", kind: "agent" },
      ]);
    });
  });

  test("listAgentsForGateway never overstates global sandbox all", async () => {
    const cfg: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "all" } } } };
    await withAgentPermissionState(async () => {
      execApprovalsStore.updateExecApprovalsForMaintenance(() => ({ version: 1 }));
      const agent = (await listAgentsForGateway(cfg)).agents.find((entry) => entry.id === "main");
      expect(agent).toBeDefined();
      expect(agent).not.toHaveProperty("defaultPermissionMode");
    });
  });

  test("listAgentsForGateway shares one approvals read across agent permission labels", async () => {
    await withAgentPermissionState(async () => {
      const cfg: OpenClawConfig = {
        tools: { exec: { mode: "ask" } },
        agents: {
          entries: {
            guarded: {},
            restricted: { tools: { exec: { mode: "allowlist" } } },
            workspace: { tools: { exec: { mode: "auto" } } },
          },
        },
      };
      expect(
        (await listAgentsForGateway(cfg)).agents.map(({ id, defaultPermissionMode }) => [
          id,
          defaultPermissionMode,
        ]),
      ).toEqual([
        ["guarded", "guarded"],
        ["restricted", undefined],
        ["workspace", "workspace"],
      ]);
    });
  });

  test("listAgentsForGateway uses the model catalog for per-agent thinking metadata", async () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          model: { primary: "local/custom-reasoner" },
        },
        entries: { main: {}, work: {}, missing: {} },
      },
    } as OpenClawConfig;
    const catalogEntry = catalogModel("local", "custom-reasoner", { name: "Custom Reasoner" });
    const disabledCatalog = [{ ...catalogEntry, reasoning: false }];
    const enabledCatalog = [{ ...catalogEntry, reasoning: true }];

    const result = await listAgentsForGateway(cfg, {
      modelCatalogByAgentId: new Map([
        ["main", { entries: disabledCatalog }],
        ["work", { entries: enabledCatalog }],
        ["missing", undefined],
      ]),
    });
    const agentsById = new Map(result.agents.map((agent) => [agent.id, agent]));

    expect(agentsById.get("main")?.thinkingLevels?.map((level) => level.id)).toEqual([
      "off",
      "ultra",
    ]);
    expect(agentsById.get("work")?.thinkingDefault).toBe("medium");
    expect(agentsById.get("work")?.thinkingLevels?.map((level) => level.id)).toContain("medium");
    expect(agentsById.get("missing")?.thinkingLevels?.map((level) => level.id)).toContain("high");
  });

  describe("listAgentsForGateway resolved model projection", () => {
    test("publishes one resolved identity for model, runtime, and thinking capabilities", async () => {
      const cfg = {
        agents: {
          defaults: {
            model: {
              primary: "sol-projection",
              fallbacks: ["openai/gpt-5.6-luna"],
            },
            models: {
              "openai/gpt-5.6-sol": {
                alias: "sol-projection",
                agentRuntime: { id: "codex" },
              },
            },
          },
          entries: { main: {} },
        },
      } as OpenClawConfig;
      const catalog = [
        catalogModel("openai", "gpt-5.6-sol", { name: "GPT-5.6 Sol", reasoning: true }),
      ];

      const agent = (
        await listAgentsForGateway(cfg, {
          modelCatalogByAgentId: new Map([["main", { entries: catalog }]]),
        })
      ).agents[0];

      expect(agent).toMatchObject({
        model: {
          primary: "openai/gpt-5.6-sol",
          fallbacks: ["openai/gpt-5.6-luna"],
        },
        agentRuntime: { id: "codex", source: "model" },
        thinkingDefault: "medium",
      });
      expect(agent?.thinkingLevels?.map((level) => level.id)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "ultra",
      ]);
      expect(agent?.thinkingOptions).toEqual(agent?.thinkingLevels?.map((level) => level.label));
    });
  });
});

describe("session list selected model display", () => {
  const fixtureStorePath = useSessionStoreFixture("openclaw-session-model-list-");

  test("searches a selected agent's global row in an ownerless explicit fleet", async () => {
    const now = Date.now();
    const result = await listSessionFixture({
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { model: { primary: "openai/gpt-5.4" } },
          entries: {
            main: { model: { primary: "openai/gpt-5.4" } },
            work: { model: { primary: "anthropic/claude-opus-4-6" } },
          },
        },
      } as OpenClawConfig,
      storePath: fixtureStorePath(),
      store: {
        global: makeSession("global", { updatedAt: now }),
      },
      opts: { agentId: "work", includeGlobal: true, search: "claude-opus" },
    });

    expect(result.sessions).toMatchObject([
      {
        key: "global",
        agentId: "work",
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
      },
    ]);
  });

  test("filters phantom agent store placeholder rows from session lists", async () => {
    const now = Date.now();
    const result = await listSessionFixture({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: fixtureStorePath(),
      store: {
        "agent:main:sessions": {} as SessionEntry,
        "agent:main:main": makeSession("sess-main", { updatedAt: now }),
      },
      opts: {},
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:main"]);
  });
});

describe("deriveSessionTitle", () => {
  const entry: SessionEntry = makeSession("abcd1234-5678-90ef-ghij-klmnopqrstuv");
  test.each([
    { name: "missing entry", entry: undefined, message: undefined, expected: undefined },
    { name: "missing message", entry, message: undefined, expected: undefined },
    { name: "empty message", entry, message: "", expected: undefined },
    { name: "blank message", entry, message: "   ", expected: undefined },
    {
      name: "emoji at the truncation boundary",
      entry,
      message: `${"t".repeat(58)}🚀 extra`,
      expected: `T${"t".repeat(57)}…`,
    },
  ])("derives a title for $name", ({ entry: session, message, expected }) => {
    expect(deriveSessionTitle(session, message)).toBe(expected);
  });
});

describe("resolveGatewayModelSupportsImages", () => {
  type Model = GatewayModelCatalogSnapshot["entries"][number];
  type Facts = Partial<GatewayModelCatalogSnapshot>;
  const vision: Model = catalogModel("openai", "gpt-5.4", {
    name: "GPT-5.4",
    input: ["text", "image"],
  });
  const baseUrl = "https://api.openai.com/v1";
  const routeVision = (api: "openai-completions" | "openai-responses", url = baseUrl) => ({
    ...vision,
    api,
    baseUrl: url,
  });
  const textOnly = (model: Model): Model => ({ ...model, input: ["text"] });
  const runtimeModel = catalogModel("openrouter", "vendor/runtime-vision-model", {
    name: "Runtime Vision Model",
    input: ["text", "image"],
  });
  const snapshot = (facts: Facts): GatewayModelCatalogSnapshot => ({
    agentId: "qa",
    agentDir: "/tmp/gateway-model-capability-agent",
    workspaceDir: "/tmp/gateway-model-capability-workspace",
    catalogComplete: false,
    config: {},
    entries: [],
    routeVariants: [],
    ...facts,
  });

  test.each<{
    name: string;
    facts: Facts | Error;
    full?: Facts;
    model?: string;
    provider?: string | null;
    expected?: boolean;
    modes?: boolean[];
  }>([
    {
      name: "discovers live capabilities after provisional text-only metadata",
      facts: { entries: [textOnly(runtimeModel)] },
      full: { entries: [runtimeModel] },
      model: runtimeModel.id,
      provider: runtimeModel.provider,
      expected: true,
    },
    {
      name: "does not rediscover a complete catalog missing the requested row",
      facts: { catalogComplete: true },
      model: "vendor/runtime-text-model",
      provider: "openrouter",
      modes: [true],
    },
    {
      name: "repairs stale text-only metadata with same-agent static vision",
      facts: { entries: [textOnly(vision)], staticEntries: [vision] },
      expected: true,
      modes: [true],
    },
    {
      name: "honors explicitly configured text-only input",
      facts: {
        config: {
          models: {
            providers: {
              openai: {
                baseUrl,
                models: [
                  {
                    id: vision.id,
                    name: "Text only",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4_096,
                  },
                ],
              },
            },
          },
        },
        entries: [textOnly({ ...vision, baseUrl })],
        staticEntries: [{ ...vision, baseUrl }],
      },
      modes: [true],
    },
    {
      name: "does not borrow static vision across the agent owner",
      facts: { agentId: "other", staticEntries: [vision] },
    },
    {
      name: "does not borrow static vision across the configured base URL",
      facts: {
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://custom.example.test/v1",
                models: [],
              },
            },
          },
        },
        staticEntries: [{ ...vision, baseUrl }],
      },
    },
    {
      name: "does not borrow static vision across the visible API",
      facts: {
        entries: [textOnly(routeVision("openai-completions"))],
        staticEntries: [routeVision("openai-responses")],
      },
    },
    {
      name: "does not borrow static vision across the visible base URL",
      facts: {
        entries: [textOnly(routeVision("openai-responses", "https://custom.example.test/v1"))],
        staticEntries: [routeVision("openai-responses")],
      },
    },
    {
      name: "fails closed on providerless static image capabilities",
      facts: {
        staticEntries: [
          { ...vision, id: "shared-vision", provider: "first" },
          { ...vision, id: "shared-vision", provider: "second" },
        ],
      },
      model: "shared-vision",
      provider: null,
    },
    {
      name: "fails closed without a stale catalog when the prepared snapshot fails",
      facts: new Error("prepared catalog unavailable"),
      modes: [true],
    },
  ])(
    "$name",
    async ({
      facts,
      full,
      model = vision.id,
      provider = vision.provider,
      expected = false,
      modes = [true, false],
    }) => {
      const loadGatewayModelCatalog = vi.fn(async () => (facts instanceof Error ? [vision] : []));
      const loadGatewayModelCatalogSnapshot = vi.fn(async (params?: { readOnly?: boolean }) => {
        if (facts instanceof Error) {
          throw facts;
        }
        if (modes.length === 1 && params?.readOnly !== true) {
          throw new Error("full catalog discovery must not restart");
        }
        return snapshot(params?.readOnly ? facts : (full ?? facts));
      });
      await expect(
        resolveGatewayModelSupportsImages({
          agentId: "qa",
          model,
          provider: provider ?? undefined,
          loadGatewayModelCatalog,
          loadGatewayModelCatalogSnapshot,
        }),
      ).resolves.toBe(expected);
      expect(loadGatewayModelCatalogSnapshot.mock.calls.map(([params]) => params)).toEqual(
        modes.map((readOnly) => ({ agentId: "qa", readOnly })),
      );
      expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    },
  );

  test.each([
    [
      "deployment-gpt5",
      "microsoft-foundry",
      catalogModel("microsoft-foundry", "deployment-gpt5", { name: "gpt-5.4", input: ["text"] }),
    ],
    [
      "claude-sonnet-4-6",
      "claude-cli",
      catalogModel("claude-cli", "claude-sonnet-4-6", {
        name: "Claude Sonnet 4.6",
        input: ["text"],
      }),
    ],
    [
      "Qwen/Qwen3.5-35B-A3B",
      undefined,
      catalogModel("modelscope", "qwen/qwen3.5-35b-a3b", {
        name: "Qwen3.5 35B",
        input: ["text", "image"],
      }),
    ],
  ] as const)("resolves legacy or providerless vision for %s", async (model, provider, entry) => {
    await expect(
      resolveGatewayModelSupportsImages({
        model,
        provider,
        loadGatewayModelCatalog: async () => [entry],
      }),
    ).resolves.toBe(true);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
