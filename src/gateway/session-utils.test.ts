import fs from "node:fs";
// Session utility tests cover key parsing, store migration, agent/default rows,
// model identity resolution, title derivation, and byte-capped row payloads.
import "./session-utils-provider.test-support.js";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import { resolveLegacyInheritedAuthAgentId } from "../agents/legacy-inherited-auth-dir.js";
import { SESSION_PERMISSION_BY_EXEC_MODE } from "../agents/session-permission-exec-mode.js";
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
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import * as execApprovalsStore from "../infra/exec-approvals-store.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";
import { registerSessionAutomationSource } from "./session-automation-index.js";
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
import {
  type GatewaySessionStoreDiscoveryCache,
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
  prepareGatewaySessionStoreTargetsReadOnly,
} from "./session-utils-store-lookup.js";
import {
  listAgentsForGateway,
  loadGatewaySessionEntryReadOnly,
  loadGatewaySessionEntry as loadSessionEntry,
  resolveCanonicalGatewaySessionStoreKey,
  resolveDeletedAgentIdFromSessionKey,
} from "./session-utils-store.js";
import { withAgentPermissionState } from "./session-utils.permissions.test-support.js";
import {
  appendTranscriptMessages,
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

test("resolves fixed-store and auth compatibility owners", () => {
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
    },
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
  expect(resolveLegacyInheritedAuthAgentId(retainLegacyDefaultAgentId(explicit, "a"))).toBe("a");
  expect(resolveLegacyInheritedAuthAgentId({ agents: { entries: { solo: {} } } })).toBe("solo");
});

test("projects a channel avatar route without exposing its media-store reference", () => {
  const key = "agent:main:discord:direct:user-1";
  const localReference = "/private/state/media/inbound/avatar.png";
  const cfg = {
    gateway: { controlUi: { basePath: "/control" } },
  } as OpenClawConfig;
  const entry = {
    sessionId: "avatar-session",
    updatedAt: 1,
    delivery: normalizeSessionDeliveryState({
      context: { channel: "discord", to: "user:user-1" },
      origin: {
        provider: "discord",
        to: "user:user-1",
        avatar: localReference,
      },
    }),
  } satisfies SessionEntry;

  const row = buildGatewaySessionRowOwner({
    cfg,
    agentId: "main",
    storePath: "",
    store: { [key]: entry },
    key,
    entry,
  });

  expect(row.channelAvatarUrl).toMatch(
    /^\/control\/__openclaw__\/channel-avatar\/agent%3Amain%3Adiscord%3Adirect%3Auser-1\?v=[A-Za-z0-9_-]{12}$/,
  );
  expect(row.origin).toEqual({ provider: "discord", to: "user:user-1" });
  expect(JSON.stringify(row)).not.toContain(localReference);
  expect(buildGatewaySessionSnapshot({ sessionRow: row })).toMatchObject({
    channelAvatarUrl: row.channelAvatarUrl,
  });

  // A replaced backing image (new media reference) must change the URL, or
  // client-side blob/404 caches keyed by URL keep serving the stale avatar.
  const replacedEntry = {
    ...entry,
    delivery: normalizeSessionDeliveryState({
      context: { channel: "discord", to: "user:user-1" },
      origin: {
        provider: "discord",
        to: "user:user-1",
        avatar: "/private/state/media/inbound/avatar-2.png",
      },
    }),
  } satisfies SessionEntry;
  const replacedRow = buildGatewaySessionRowOwner({
    cfg,
    agentId: "main",
    storePath: "",
    store: { [key]: replacedEntry },
    key,
    entry: replacedEntry,
  });
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
        list: [{ id: "roboclaw", identity: { name: "Roboclaw", avatar: "avatar.png" } }],
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

  test("projects an inherited parent model as the child's effective selection", () => {
    const parentKey = "agent:main:dashboard:parent";
    const childKey = "agent:main:dashboard:child";
    const parentEntry: SessionEntry = {
      sessionId: "parent",
      updatedAt: 1,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      modelOverrideSource: "user",
    };
    const childEntry: SessionEntry = {
      sessionId: "child",
      updatedAt: 2,
      parentSessionKey: parentKey,
    };
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({
        primary: "openai/gpt-5.4",
        models: { "anthropic/claude-sonnet-4-6": {} },
      }),
      store: { [parentKey]: parentEntry, [childKey]: childEntry },
      key: childKey,
      entry: childEntry,
    });

    expect(row.modelProvider).toBe("anthropic");
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.modelOverrideSource).toBe("inherited");
  });

  test("projects the active fallback model separately from the selected model", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "ollama/qwen3.5:9b" }),
      key: "main",
      entry: {
        sessionId: "fallback-session",
        updatedAt: 1,
        providerOverride: "codex",
        modelOverride: "gpt-5.5",
        modelProvider: "ollama",
        model: "qwen3.5:9b",
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
      activeModelProvider: "ollama",
      activeModel: "qwen3.5:9b",
    });
  });

  test("does not project a stale fallback notice after the runtime returns to the selection", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "codex/gpt-5.5" }),
      key: "main",
      entry: {
        sessionId: "recovered-session",
        updatedAt: 1,
        modelProvider: "codex",
        model: "gpt-5.5",
        fallbackNotice: {
          kind: "active",
          selectedModel: "codex/gpt-5.5",
          activeModel: "ollama/qwen3.5:9b",
        },
      },
    });

    expect(row.activeModelProvider).toBeUndefined();
    expect(row.activeModel).toBeUndefined();
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
      storePath: "",
      store: {},
      key: "main",
      entry: {
        sessionId: context.sessionId,
        updatedAt: 1,
        status: "running",
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
    const observerDigest = {
      sessionKey: "agent:main:main",
      runId: "run-1",
      revision: 3,
      updatedAt: 2_000,
      headline: "Wrapping up the implementation",
      assessment: "The focused tests pass.",
      health: "wrapping-up" as const,
      planProgress: { completed: 3, total: 4 },
    };
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      entry: { sessionId: "session", updatedAt: 1, observerDigest },
    });

    expect(row.observerDigest).toEqual({
      runId: observerDigest.runId,
      headline: observerDigest.headline,
      health: observerDigest.health,
      updatedAt: observerDigest.updatedAt,
      revision: observerDigest.revision,
    });
    expect(buildGatewaySessionSnapshot({ sessionRow: row }).observerDigest).toEqual(
      row.observerDigest,
    );
  });

  test("does not project an observer digest older than the latest run", () => {
    const row = buildGatewaySessionRow({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      entry: {
        sessionId: "session",
        updatedAt: 3_000,
        startedAt: 3_000,
        observerDigest: {
          sessionKey: "agent:main:main",
          runId: "previous-run",
          revision: 2,
          updatedAt: 2_000,
          headline: "Previous run failed",
          health: "failed",
        },
      },
    });

    expect(row.observerDigest).toBeUndefined();
    expect(buildGatewaySessionSnapshot({ sessionRow: row }).observerDigest).toBeNull();
  });

  test("Activity lists select newest interactions and completions before the 100-row page", async () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    const now = Date.now();
    const store: Record<string, SessionEntry> = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `session-${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: now - index,
          lastActivityAt: now - 10_000 - index,
          ...(index === 0 ? { pinnedAt: now } : {}),
        } satisfies SessionEntry,
      ]),
    );
    store["new-completion"] = {
      sessionId: "new-completion",
      updatedAt: now - 100_000,
      lastActivityAt: now - 1,
      lastInteractionAt: now - 200_000,
    };
    store["new-input"] = {
      sessionId: "new-input",
      updatedAt: now - 200_000,
      lastActivityAt: now - 200_000,
      lastInteractionAt: now,
    };
    const original = structuredClone(store);
    const firstPage = await listSessionFixture({
      cfg,
      storePath: "",
      store,
      opts: { sortBy: "activity" },
    });
    expect(firstPage.sessions.map((row) => row.key)).toEqual([
      "new-input",
      "new-completion",
      ...Array.from({ length: 98 }, (_, index) => `session-${index}`),
    ]);
    expect(firstPage).toMatchObject({ totalCount: 103, nextOffset: 100, hasMore: true });
    const lastPage = await listSessionFixture({
      cfg,
      storePath: "",
      store,
      opts: { sortBy: "activity", offset: firstPage.nextOffset ?? 0 },
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
    const now = 1_800_000_000_000;
    const cutoff = now - 60 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    onTestFinished(() => clock.mockRestore());
    const store: Record<string, SessionEntry> = {
      "new-input": {
        sessionId: "new-input",
        updatedAt: cutoff - 1,
        lastActivityAt: cutoff - 1,
        lastInteractionAt: now,
      },
      "boundary-completion": {
        sessionId: "boundary-completion",
        updatedAt: cutoff - 1,
        lastActivityAt: cutoff,
      },
      "metadata-only-update": {
        sessionId: "metadata-only-update",
        updatedAt: now,
        lastActivityAt: cutoff - 1,
        lastInteractionAt: cutoff - 2,
      },
      "legacy-boundary": { sessionId: "legacy-boundary", updatedAt: cutoff },
      "old-session": { sessionId: "old-session", updatedAt: cutoff - 1 },
    };
    const activity = await listSessionFixture({
      cfg,
      storePath: "",
      store,
      opts: { sortBy: "activity", activeMinutes: 60 },
    });
    expect(activity.sessions.map((row) => row.key)).toEqual([
      "new-input",
      "boundary-completion",
      "legacy-boundary",
    ]);
    expect(activity.totalCount).toBe(3);
    const ordinary = await listSessionFixture({
      cfg,
      storePath: "",
      store,
      opts: { activeMinutes: 60 },
    });
    expect(ordinary.sessions.map((row) => row.key)).toEqual([
      "metadata-only-update",
      "legacy-boundary",
    ]);
  });

  test("session lists page from an offset after filtering and sorting", async () => {
    const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
    const store = Object.fromEntries(
      Array.from({ length: 6 }, (_value, index) => [
        `session-${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: 1_000 - index,
          displayName: index === 5 ? "Different project" : `Project Alpha ${index}`,
        } satisfies SessionEntry,
      ]),
    );

    const listed = await listSessionFixture({
      cfg,
      storePath: "",
      store,
      opts: { search: "alpha", limit: 2, offset: 2 },
    });

    expect(listed.sessions.map((session) => session.key)).toEqual(["session-2", "session-3"]);
    expect(listed.count).toBe(2);
    expect(listed.totalCount).toBe(5);
    expect(listed.limitApplied).toBe(2);
    expect(listed.offset).toBe(2);
    expect(listed.nextOffset).toBe(4);
    expect(listed.hasMore).toBe(true);
  });

  test("session defaults and rows use the concrete runtime thinking policy", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push(
      {
        pluginId: "anthropic",
        source: "test",
        provider: {
          id: "anthropic",
          label: "Anthropic",
          auth: [],
          resolveThinkingProfile: () => ({
            levels: [{ id: "minimal" }, { id: "medium" }, { id: "adaptive" }],
            defaultLevel: "adaptive",
            preserveWhenCatalogReasoningFalse: true,
          }),
        },
      },
      {
        pluginId: "anthropic",
        source: "test",
        provider: {
          id: "claude-cli",
          label: "Claude CLI",
          auth: [],
          resolveThinkingProfile: () => ({
            levels: [{ id: "off" }],
            defaultLevel: "off",
          }),
        },
      },
    );
    setTestActivePluginRegistry(registry);

    const cfg = createModelDefaultsConfig({ primary: "anthropic/claude-mythos-5" });
    const catalog = [
      {
        provider: "anthropic",
        id: "claude-mythos-5",
        name: "Claude Mythos 5",
        reasoning: false,
        thinkingPolicyProvider: "claude-cli",
      },
    ];

    const defaults = getSessionDefaults(cfg, catalog);
    const row = buildGatewaySessionRow({
      cfg,
      key: "main",
      modelCatalog: catalog,
    });

    expect(defaults.thinkingLevels?.map((level) => level.id)).toEqual(["off", "ultra"]);
    expect(row.thinkingLevels?.map((level) => level.id)).toEqual(["off", "ultra"]);
    expect(defaults.thinkingDefault).toBe("off");
    expect(row.thinkingDefault).toBe("off");
  });

  test("session defaults and rows use dynamic catalog context limits with authored caps", () => {
    const catalog = [
      {
        provider: "dynamic-router",
        id: "reasoner",
        name: "Reasoner",
        contextWindow: 256_000,
        contextTokens: 200_000,
      },
    ];
    const cfg = createModelDefaultsConfig({ primary: "dynamic-router/reasoner" });

    expect(getSessionDefaults(cfg, catalog).contextTokens).toBe(200_000);
    expect(
      buildGatewaySessionRow({
        cfg,
        modelCatalog: catalog,
      }).contextTokens,
    ).toBe(200_000);

    const capped = {
      ...cfg,
      models: {
        providers: {
          "dynamic-router": {
            models: [{ id: "reasoner", contextWindow: 128_000 }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(getSessionDefaults(capped, catalog).contextTokens).toBe(128_000);
    expect(
      buildGatewaySessionRow({
        cfg: capped,
        modelCatalog: catalog,
      }).contextTokens,
    ).toBe(128_000);
  });

  test("session rows project the selected catalog context window", () => {
    const catalog = [
      {
        provider: "window-fixture",
        id: "selectable-model",
        name: "Selectable Model",
        contextWindow: 1_000_000,
        contextWindows: [
          { id: "200k", label: "200K", contextWindow: 200_000 },
          { id: "1m", label: "1M", contextWindow: 1_000_000 },
        ],
        contextWindowDefault: "1m",
      },
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
        {
          provider: "ollama",
          id: "qwen3:8b",
          name: "Qwen",
          contextWindow: 128_000,
          api: "ollama" as const,
          contextWindows: [
            { id: "32000", label: "32K", contextWindow: 32_000 },
            { id: "128000", label: "128K", contextWindow: 128_000 },
          ],
        },
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
        skipTranscriptUsageFallback: true,
      });
      expect(bound.hasAutomation).toBe(true);
      expect(buildGatewaySessionSnapshot({ sessionRow: bound }).hasAutomation).toBe(true);

      const plain = buildGatewaySessionRow({
        cfg,
        key: "agent:main:other",
        lightweightListRow: true,
        skipTranscriptUsageFallback: true,
      });
      expect(plain.hasAutomation).toBeUndefined();
      expect(buildGatewaySessionSnapshot({ sessionRow: plain }).hasAutomation).toBe(false);
    } finally {
      registerSessionAutomationSource(null);
    }
  });

  test("session list thinking cache preserves case-distinct model catalog entries", async () => {
    const cfg = createModelDefaultsConfig({ primary: "custom/CaseModel" });
    const modelCatalog = [
      {
        provider: "custom",
        id: "CaseModel",
        name: "CaseModel",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      },
      {
        provider: "custom",
        id: "casemodel",
        name: "casemodel",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
      },
    ];
    const result = await listSessionFixture({
      cfg,
      storePath: "",
      modelCatalog,
      store: {
        upper: {
          sessionId: "upper",
          providerOverride: "custom",
          modelOverride: "CaseModel",
          modelProvider: "custom",
          model: "CaseModel",
          updatedAt: 2,
        } satisfies SessionEntry,
        lower: {
          sessionId: "lower",
          providerOverride: "custom",
          modelOverride: "casemodel",
          modelProvider: "custom",
          model: "casemodel",
          updatedAt: 1,
        } satisfies SessionEntry,
      },
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
    const [providerId, options] =
      providerArtifactMocks.resolveBundledProviderPolicySurface.mock.calls.at(-1) ?? [];
    expect(providerId).toBe("openai");
    expect(options).toHaveProperty("manifestRegistry");
  });

  test("strips retired thinking provenance from Gateway patch results", () => {
    const entry = {
      sessionId: "private-fallback",
      updatedAt: 1,
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
      canonicalKey: "agent:main:main",
      cfg: {
        agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
      } as OpenClawConfig,
      entry,
      modelCatalog: [
        {
          provider: "openai",
          id: "gpt-5.6-sol",
          name: "GPT 5.6 Sol",
          reasoning: true,
        },
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
      const entry = (sessionId: string): InternalSessionEntry => ({
        sessionId,
        updatedAt: 1,
        agentHarnessId: "test-native",
        modelSelectionLocked: true,
        modelProvider: "stale-provider",
        model: "stale-model",
      });
      const nativeKey = "agent:main:harness:test-native:native";
      const hostAuthKey = "agent:main:harness:test-native:host-auth";
      const unprovenKey = "agent:main:harness:test-native:unproven";
      const concreteKey = "agent:main:concrete";
      const native = entry("native-model-row");
      const hostAuth = entry("host-auth-model-row");
      const unproven = entry("unproven-model-row");
      const concrete: InternalSessionEntry = {
        ...entry("concrete-model-row"),
        pluginOwnerId: "test-native",
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      };
      const store = {
        [nativeKey]: native,
        [hostAuthKey]: hostAuth,
        [unprovenKey]: unproven,
        [concreteKey]: concrete,
      };
      const bindings = new Map<
        string,
        { sessionId: string; auth: "native" | "host"; model: string }
      >([
        [
          nativeKey,
          { sessionId: native.sessionId, auth: "native" as const, model: "gpt-5.6-luna" },
        ],
        [
          hostAuthKey,
          { sessionId: hostAuth.sessionId, auth: "host" as const, model: "gpt-5.6-sol" },
        ],
      ]);
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
            const binding = params.sessionKey ? bindings.get(params.sessionKey) : undefined;
            return binding?.sessionId === params.sessionId
              ? {
                  model: "native" as const,
                  auth: binding.auth,
                  modelRef: { provider: "openai", model: binding.model },
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
          skipTranscriptUsageFallback: true,
        });
      const nativeRow = readRow(nativeKey);
      expect(nativeRow).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-luna" });
      const matches = await listSessionFixture({
        cfg,
        storePath: "",
        store,
        opts: { search: "openai/gpt-5.6-luna" },
      });
      expect(matches.sessions.map((row) => row.key)).toEqual([nativeKey]);
      expect(buildGatewaySessionSnapshot({ sessionRow: nativeRow })).toMatchObject({
        modelProvider: "openai",
        model: "gpt-5.6-luna",
      });
      expect(readRow(hostAuthKey)).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-sol" });
      expect(readRow(concreteKey)).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-sol" });
      expect(readRow(unprovenKey)).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-sol" });
      expect(native.model).toBe("stale-model");
      bindings.delete(nativeKey);
      expect(readRow(nativeKey)).toMatchObject({ modelProvider: "openai", model: "gpt-5.6-sol" });
    },
  );

  test.each(["xhigh"] as const)(
    "preserves catalog-less persisted %s in session change projections",
    (thinkingLevel) => {
      const row = buildGatewaySessionRow({
        cfg: createModelDefaultsConfig({ primary: "custom/reasoner" }),
        entry: { sessionId: thinkingLevel, thinkingLevel } as SessionEntry,
      });

      expect(row.thinkingLevel).toBe(thinkingLevel);
    },
  );

  test("session rows preserve fresh zero-token usage", () => {
    const row = buildGatewaySessionRow({
      cfg: {} as OpenClawConfig,
      entry: {
        sessionId: "fresh-zero-token-session",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });

    expect(row.totalTokens).toBe(0);
    expect(row.totalTokensFresh).toBe(true);
  });

  test("selected global rows read transcript usage from the selected agent", async () => {
    await withStateDirEnv("session-utils-selected-global-usage-", async ({ stateDir }) => {
      const sessionId = "selected-global-usage";
      for (const [agentId, input] of [
        ["main", 10],
        ["work", 40],
      ] as const) {
        const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
        seedSessionEntries(storePath, {
          global: { sessionId, updatedAt: 1 },
        });
        appendTranscriptMessages({
          agentId,
          sessionId,
          sessionKey: "global",
          storePath,
          messages: [
            {
              role: "assistant",
              content: "done",
              usage: { input, output: 2 },
            },
          ],
        });
      }

      const row = buildGatewaySessionRow({
        cfg: {
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        } as OpenClawConfig,
        key: "global",
        agentId: "work",
        entry: { sessionId, updatedAt: 1 },
      });

      expect(row.totalTokens).toBe(40);
    });
  });

  test("SQLite unavailable context blocks old totals until a later valid snapshot", async () => {
    await withStateDirEnv("session-utils-unavailable-usage-", async ({ stateDir }) => {
      const sessionId = "unavailable-usage";
      const sessionKey = "agent:main:main";
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const entry: SessionEntry = {
        sessionId,
        updatedAt: 1,
        totalTokens: 1_124_767,
        totalTokensFresh: false,
      };
      seedSessionEntries(storePath, { [sessionKey]: entry });
      appendTranscriptMessages({
        sessionId,
        sessionKey,
        storePath,
        messages: [
          {
            role: "assistant",
            api: "cli",
            content: "old cumulative turn",
            usage: {
              input: 128_814,
              output: 3_000,
              cacheRead: 992_953,
              totalTokens: 1_124_767,
            },
          },
        ],
      });

      const legacyRow = buildGatewaySessionRow({
        cfg: createModelDefaultsConfig({ primary: "anthropic/claude-opus-4-7" }),
        storePath,
        store: { [sessionKey]: entry },
        key: sessionKey,
        entry,
      });
      expect(legacyRow.totalTokens).toBeUndefined();
      expect(legacyRow.totalTokensFresh).toBe(false);

      appendTranscriptMessages({
        sessionId,
        sessionKey,
        storePath,
        messages: [
          {
            role: "assistant",
            api: "cli",
            content: "usage unavailable",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              contextUsage: { state: "unavailable" },
            },
          },
        ],
      });

      const unavailableRow = buildGatewaySessionRow({
        cfg: createModelDefaultsConfig({ primary: "anthropic/claude-opus-4-7" }),
        storePath,
        store: { [sessionKey]: entry },
        key: sessionKey,
        entry,
      });
      expect(unavailableRow.totalTokens).toBeUndefined();
      expect(unavailableRow.totalTokensFresh).toBe(false);

      appendTranscriptMessages({
        sessionId,
        sessionKey,
        storePath,
        messages: [
          {
            role: "assistant",
            api: "cli",
            content: "valid later turn",
            usage: {
              input: 67_932,
              output: 2_000,
              cacheRead: 18_944,
              totalTokens: 88_876,
              contextUsage: {
                state: "available",
                promptTokens: 86_876,
                totalTokens: 88_876,
              },
            },
          },
        ],
      });
      const validRow = buildGatewaySessionRow({
        cfg: createModelDefaultsConfig({ primary: "anthropic/claude-opus-4-7" }),
        storePath,
        store: { [sessionKey]: entry },
        key: sessionKey,
        entry,
      });
      expect(validRow.totalTokens).toBe(86_876);
      expect(validRow.totalTokensFresh).toBe(true);
    });
  });

  test("buildGatewaySessionRow displayName falls through to origin label for direct sessions", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "direct-42",
      updatedAt: 1,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "42" },
        origin: { label: "openclaw-tui" },
      }),
    };
    const row = buildGatewaySessionRow({
      cfg,
      store: { "agent:main:telegram:direct:42": entry },
      key: "agent:main:telegram:direct:42",
      entry,
    });
    expect(row.displayName).toBe("openclaw-tui");
  });

  test("buildGatewaySessionRow does not promote direct route identities as display names", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "direct-phone",
      updatedAt: 1,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "imessage", to: "auto:+15551234567" },
        origin: {
          provider: "imessage",
          label: "+15551234567",
          from: "auto:+15551234567",
        },
      }),
    };
    const row = buildGatewaySessionRow({
      cfg,
      store: { "agent:main:imessage:direct:+15551234567": entry },
      key: "agent:main:imessage:direct:+15551234567",
      entry,
    });
    expect(row.displayName).toBeUndefined();
  });

  test("buildGatewaySessionRow keeps human contact aliases that match a route tail", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "direct-contact",
      updatedAt: 1,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "imessage", to: "imessage:Alice" },
        origin: {
          provider: "imessage",
          label: "Alice",
          from: "imessage:Alice",
        },
      }),
    };
    const row = buildGatewaySessionRow({
      cfg,
      store: { "agent:main:imessage:direct:Alice": entry },
      key: "agent:main:imessage:direct:Alice",
      entry,
    });
    expect(row.displayName).toBe("Alice");
  });

  test("buildGatewaySessionRow does not promote compact group route fallbacks as names", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "group-13",
      updatedAt: 1,
      chatType: "group",
      groupId: "13",
      displayName: "imessage:g-13",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "imessage", to: "chat_id:13" },
        origin: {
          provider: "imessage",
          label: "Group id:13",
          from: "imessage:group:13",
        },
      }),
    };
    const row = buildGatewaySessionRow({
      cfg,
      store: { "agent:main:imessage:group:13": entry },
      key: "agent:main:imessage:group:13",
      entry,
    });
    expect(row.displayName).toBeUndefined();
  });

  test.each<[string, Partial<SessionEntry>, string]>([
    [
      "explicit rename",
      { label: "  OpenClaw App · Release planning · 1234567890ab  " },
      "OpenClaw App · Release planning · 1234567890ab",
    ],
    ["empty automatic name", { displayName: undefined, autoLabel: "" }, ""],
  ])("buildGatewaySessionRow preserves title precedence for %s", (_name, overrides, expected) => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const key = "agent:main:node-1234567890ab";
    const entry: SessionEntry = {
      sessionId: "node-1",
      updatedAt: 1,
      autoLabel: "OpenClaw App · Pixel · 1234567890ab",
      displayName: "Release Planning",
      ...overrides,
    };
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: { [key]: entry },
      key,
      entry,
    });
    expect(row.autoLabel).toBe(entry.autoLabel);
    expect(row.label).toBe(entry.label);
    expect(row.displayName).toBe(expected);
  });

  test("refreshes forum topic titles without replacing sessions or explicit labels", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-topic-session-title-"));
    const storePath = path.join(dir, "sessions.json");
    const cfg = { agents: { entries: { main: {} } } } satisfies OpenClawConfig;
    const key = "agent:main:telegram:group:-1001234567890:topic:42";
    const siblingKey = "agent:main:telegram:group:-1001234567890:topic:43";
    const readStore = () =>
      Object.fromEntries(
        listSessionEntriesReadOnly({ agentId: "main", storePath }).map(
          ({ sessionKey, entry }) => [sessionKey, entry] as const,
        ),
      );
    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-1001234567890:topic:42",
      To: "telegram:-1001234567890",
      GroupSubject: "Project Team",
      MessageThreadId: 42,
      IsForum: true,
    };
    try {
      for (const sessionKey of [key, siblingKey]) {
        await replaceSessionEntry(
          { sessionKey, storePath },
          { sessionId: sessionKey, updatedAt: 1, chatType: "group", subject: "Project Team" },
        );
      }
      await recordInboundSessionMeta({
        storePath,
        sessionKey: siblingKey,
        ctx: {
          ...ctx,
          From: "telegram:group:-1001234567890:topic:43",
          MessageThreadId: 43,
          TopicName: "Releases",
        },
      });
      for (const [topicName, title] of [
        [undefined, "Project Team"],
        ["  ", "Project Team"],
        [" Planning ", "Project Team / Planning"],
        ["Planning", "Project Team / Planning"],
        ["Roadmap", "Project Team / Roadmap"],
      ]) {
        await recordInboundSessionMeta({
          storePath,
          sessionKey: key,
          ctx: { ...ctx, TopicName: topicName },
        });
        await closeSessionSqliteDatabasesForTest();
        const store = readStore();
        const entry = expectDefined(store[key], "topic session");
        const row = buildGatewaySessionRow({ cfg, storePath, store, key, entry });
        expect(row.displayName).toBe(title);
        expect(entry.sessionId).toBe(key);
        expect(entry.subject).toBe("Project Team");
        expect(row.origin?.threadId).toBe(42);
        const sibling = buildGatewaySessionRow({
          cfg,
          storePath,
          store,
          key: siblingKey,
          entry: store[siblingKey],
        });
        expect(sibling.displayName).toBe("Project Team / Releases");
      }
      const store = readStore();
      const previous = expectDefined(store[key], "topic session before sparse update");
      await recordInboundSessionMeta({
        storePath,
        sessionKey: key,
        ctx: { ...ctx, GroupSubject: undefined },
      });
      expect(readStore()[key]).toMatchObject({
        subject: previous.subject,
        displayName: previous.displayName,
        topicName: "Roadmap",
      });
      await replaceSessionEntry(
        { sessionKey: key, storePath },
        { ...previous, label: "My planning chat" },
      );
      await recordInboundSessionMeta({
        storePath,
        sessionKey: key,
        ctx: { ...ctx, TopicName: "Next" },
      });
      const labeledStore = readStore();
      const labeledRow = buildGatewaySessionRow({
        cfg,
        storePath,
        store: labeledStore,
        key,
        entry: labeledStore[key],
      });
      expect(labeledRow.displayName).toBe("My planning chat");
    } finally {
      await closeSessionSqliteDatabasesForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildGatewaySessionRow group displayName prefers #channel and falls back to the token", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const channelEntry: SessionEntry = {
      sessionId: "channel-C1",
      updatedAt: 1,
      chatType: "channel",
      delivery: normalizeSessionDeliveryState({ context: { channel: "slack", to: "channel:C1" } }),
      groupChannel: "general",
      space: "Acme",
    };
    const channelRow = buildGatewaySessionRow({
      cfg,
      store: { "agent:main:slack:channel:C1": channelEntry },
      key: "agent:main:slack:channel:C1",
      entry: channelEntry,
    });
    expect(channelRow.displayName).toBe("Acme #general");
    const labeled = { ...channelEntry, label: "Team room" } as SessionEntry;
    const labeledRow = buildGatewaySessionRow({
      cfg,
      store: { "agent:main:slack:channel:C1": labeled },
      key: "agent:main:slack:channel:C1",
      entry: labeled,
    });
    expect(labeledRow.displayName).toBe("Team room");

    const opaque: SessionEntry = {
      sessionId: "group-opaque",
      updatedAt: 1,
      chatType: "group",
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram", to: "group:99" } }),
    };
    const opaqueRow = buildGatewaySessionRow({
      cfg,
      store: { "agent:main:telegram:group:99": opaque },
      key: "agent:main:telegram:group:99",
      entry: opaque,
    });
    expect(opaqueRow.displayName).toMatch(/^telegram:/);
  });

  test("buildGatewaySessionRow projects the session root only for an explicit permission mode", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const ordinaryEntry: SessionEntry = {
      sessionId: "ordinary",
      sessionRoot: "/workspace/private",
      updatedAt: 1,
    };
    const ordinaryRow = buildGatewaySessionRow({
      cfg,
      store: { "agent:main:ordinary": ordinaryEntry },
      key: "agent:main:ordinary",
      entry: ordinaryEntry,
    });
    expect(ordinaryRow).not.toHaveProperty("sessionRoot");

    const permissionEntry: SessionEntry = {
      ...ordinaryEntry,
      permissionMode: "workspace",
      sessionId: "permission",
    };
    const permissionRow = buildGatewaySessionRow({
      cfg,
      store: { "agent:main:permission": permissionEntry },
      key: "agent:main:permission",
      entry: permissionEntry,
    });
    expect(permissionRow).toMatchObject({
      permissionMode: "workspace",
      sessionRoot: "/workspace/private",
    });
  });

  test("resolveSessionStoreKey maps main aliases to default agent main", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "work" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:MAIN" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:main:work" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "MAIN" })).toBe("agent:ops:work");
  });

  test("resolveDeletedAgentIdFromSessionKey rejects non-alias main keys when main is absent", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const legacyMainAlias = resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" });

    expect(legacyMainAlias).toBe("agent:ops:work");
    expect(resolveDeletedAgentIdFromSessionKey(cfg, legacyMainAlias)).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "global")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "unknown")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "main")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "agent:main:discord:direct:u1")).toBe("main");
  });

  test("resolveDeletedAgentIdFromSessionKey ignores confirmed ACP runtime session keys", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const acpEntry = (agent: string, runtimeSessionName: string) =>
      ({
        acp: {
          backend: "acpx",
          agent,
          runtimeSessionName,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 1,
        },
      }) as SessionEntry;
    const claudeKey = "agent:claude:acp:11111111-1111-4111-8111-111111111111";
    const cursorKey = "agent:cursor:acp:22222222-2222-4222-8222-222222222222";
    expect(
      resolveDeletedAgentIdFromSessionKey(cfg, claudeKey, acpEntry("claude", claudeKey)),
    ).toBeNull();
    expect(
      resolveDeletedAgentIdFromSessionKey(cfg, cursorKey, acpEntry("cursor", cursorKey)),
    ).toBeNull();
  });

  test("resolveDeletedAgentIdFromSessionKey rejects ACP-shaped bridge keys without ACP metadata", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    expect(
      resolveDeletedAgentIdFromSessionKey(cfg, "agent:main:acp:configured-bridge-without-meta", {
        acp: undefined,
        sessionId: "sess-configured-bridge",
        updatedAt: 1,
      }),
    ).toBeNull();

    expect(
      resolveDeletedAgentIdFromSessionKey(
        cfg,
        "agent:deleted-agent:acp:bridge-session-without-runtime-meta",
        { acp: undefined, sessionId: "sess-deleted-bridge", updatedAt: 1 },
      ),
    ).toBe("deleted-agent");
  });

  test("resolveDeletedAgentIdFromSessionKey repairs canonical ACP metadata aliases", async () => {
    await withStateDirEnv("session-utils-acp-deleted-agent-repair-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "claude", "sessions", "sessions.json");
      const acpKey = "agent:claude:acp:55555555-5555-4555-8555-555555555555";
      const legacyAcpKey = "agent:CLAUDE:acp:55555555-5555-4555-8555-555555555555";
      const entry = {
        sessionId: "sess-acp-repair",
        updatedAt: 1,
      } satisfies SessionEntry;
      seedSessionEntries(storePath, {
        [acpKey]: entry,
      });
      writeAcpSessionMetaForMigration({
        sessionKey: legacyAcpKey,
        lifecycleRevision: undefined,
        meta: {
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: legacyAcpKey,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 1,
        },
      });
      const cfg = {
        session: {
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      expect(
        resolveDeletedAgentIdFromSessionKey(cfg, acpKey, entry, {
          acpMetadataSessionKey: acpKey,
        }),
      ).toBeNull();
    });
  });

  test("resolveDeletedAgentIdFromSessionKey rejects deleted configured ACP binding owners", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    expect(
      resolveDeletedAgentIdFromSessionKey(
        cfg,
        "agent:deleted-agent:acp:binding:discord:default:feedface",
      ),
    ).toBe("deleted-agent");
    expect(
      resolveDeletedAgentIdFromSessionKey(cfg, "agent:main:acp:binding:discord:default:feedface"),
    ).toBeNull();
  });

  test.each([false])(
    "resolveSessionStoreKey canonicalizes bare keys (explicit sole: %s)",
    (explicitOwnership) => {
      const cfg: OpenClawConfig = {
        session: { mainKey: "main" },
        agents: explicitOwnership
          ? { ownership: "explicit", entries: { ops: {} } }
          : { list: [{ id: "ops", default: true }] },
      };
      expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toBe(
        "agent:ops:discord:group:123",
      );
      expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:main" })).toBe(
        "agent:alpha:main",
      );
      expect(resolveSessionStoreAgentId(cfg, "global")).toBe("ops");
    },
  );

  test("resolveSessionStoreKey uses configured fixed-store ownership for bare keys", () => {
    const cfg = {
      session: { mainKey: "main", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:main");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "thread-1" })).toBe("agent:ops:thread-1");
    expect(resolveSessionStoreAgentId(cfg, "global")).toBe("ops");
  });

  test("session-store key ownership rejects a retired fixed-store owner", () => {
    const cfg = {
      session: { mainKey: "main", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "retired" } },
        entries: { ops: {}, research: {} },
      },
    } as OpenClawConfig;
    expect(() => resolveSessionStoreKey({ cfg, sessionKey: "thread-1" })).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
    );
    expect(() => resolveSessionStoreAgentId(cfg, "global")).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
    );
  });

  test("resolveSessionStoreKey honors global scope", () => {
    const cfg = {
      session: { scope: "global", mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("global");
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("global");
    expect(target.agentId).toBe("ops");
  });

  test("resolveGatewaySessionStoreTarget keeps a fixed configured store authoritative", async () => {
    await withStateDirEnv("session-utils-fixed-store-", async ({ stateDir }) => {
      const fixedStorePath = path.join(stateDir, "configured", "sessions.json");
      const staleStorePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
      seedSessionEntries(fixedStorePath, {
        "agent:ops:main": { sessionId: "sess-fixed", updatedAt: 1 },
      });
      seedSessionEntries(staleStorePath, {
        "agent:ops:main": { sessionId: "sess-stale", updatedAt: 99 },
      });
      const cfg = {
        session: { mainKey: "main", store: fixedStorePath },
        agents: { list: [{ id: "ops", default: true }] },
      } as OpenClawConfig;

      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: "agent:ops:main",
      });

      expect(target.storePath).toBe(path.resolve(fixedStorePath));
      expect(target.store["agent:ops:main"]?.sessionId).toBe("sess-fixed");
      expect(
        prepareGatewaySessionStoreTargetsReadOnly({
          cfg,
          targets: [{ key: "agent:ops:main" }],
          projection: "list",
        }),
      ).toMatchObject([
        {
          ok: true,
          value: {
            storePath: path.resolve(fixedStorePath),
            store: { "agent:ops:main": { sessionId: "sess-fixed" } },
          },
        },
      ]);
    });
  });

  test("resolveGatewaySessionStoreTarget keeps discovered contents paired with their path", async () => {
    await withStateDirEnv("session-utils-discovered-contents-", async ({ stateDir }) => {
      const retiredSessionsDir = path.join(stateDir, "agents", "Retired Agent", "sessions");
      fs.mkdirSync(retiredSessionsDir, { recursive: true });
      const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
      seedSessionEntries(retiredStorePath, {
        "agent:retired-agent:other": { sessionId: "sess-discovered-other", updatedAt: 1 },
      });
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      const fallbackStore = {
        "agent:retired-agent:main": { sessionId: "sess-fallback", updatedAt: 99 },
      };

      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: "agent:retired-agent:main",
        store: fallbackStore,
      });

      expect(target.storePath).toBe(path.resolve(retiredStorePath));
      expect(target.store).toHaveProperty("agent:retired-agent:other");
      expect(target.store).not.toHaveProperty("agent:retired-agent:main");
    });
  });

  test("batched session targets preserve explicit sentinel owners and reject discovered collisions", async () => {
    await withStateDirEnv("session-utils-batch-owners-", async ({ stateDir }) => {
      const cfg = {
        session: { store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json") },
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig;
      for (const agentId of ["ops", "research"]) {
        await replaceSessionEntry(
          {
            agentId,
            sessionKey: "global",
            storePath: cfg.session.store.replaceAll("{agentId}", agentId),
          },
          { sessionId: `global-${agentId}`, updatedAt: 1 },
        );
      }
      expect(
        prepareGatewaySessionStoreTargetsReadOnly({
          cfg,
          targets: ["research", "ops"].map((agentId) => ({ key: "global", agentId })),
          projection: "list",
        }),
      ).toMatchObject([
        {
          ok: true,
          value: { agentId: "research", store: { global: { sessionId: "global-research" } } },
        },
        { ok: true, value: { agentId: "ops", store: { global: { sessionId: "global-ops" } } } },
      ]);
      for (const directory of ["Retired Agent", "retired-agent"]) {
        seedSessionEntries(path.join(stateDir, "agents", directory, "sessions", "sessions.json"), {
          "agent:retired-agent:main": { sessionId: directory, updatedAt: 1 },
        });
      }
      const key = "agent:retired-agent:main";
      expect(() =>
        resolveGatewaySessionStoreTargetWithStore({ cfg, key, readOnly: true, exactRead: true }),
      ).toThrow("openclaw doctor --fix");
      expect(
        prepareGatewaySessionStoreTargetsReadOnly({ cfg, targets: [{ key }], projection: "list" }),
      ).toMatchObject([
        { ok: false, error: { message: expect.stringContaining("openclaw doctor --fix") } },
      ]);
    });
  });

  test("resolveGatewaySessionStoreTarget finds a retired agent's row under another configured agent's template root", async () => {
    await withStateDirEnv("session-utils-retired-cross-root-", async ({ tempRoot }) => {
      const storesRoot = path.join(tempRoot, "stores");
      const retiredStorePath = path.join(
        storesRoot,
        "work",
        "agents",
        "old",
        "sessions",
        "sessions.json",
      );
      seedSessionEntries(retiredStorePath, {
        "agent:old:main": { sessionId: "sess-retired-cross-root", updatedAt: 1 },
      });
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(
            storesRoot,
            "{agentId}",
            "agents",
            "{agentId}",
            "sessions",
            "sessions.json",
          ),
        },
        agents: { list: [{ id: "ops", default: true }, { id: "work" }] },
      } as OpenClawConfig;

      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: "agent:old:main",
      });

      expect(target.storePath).toBe(path.resolve(retiredStorePath));
      expect(target.store["agent:old:main"]?.sessionId).toBe("sess-retired-cross-root");
      expect(
        prepareGatewaySessionStoreTargetsReadOnly({
          cfg,
          targets: [{ key: "agent:old:main" }],
          projection: "list",
        }),
      ).toMatchObject([
        {
          ok: true,
          value: {
            storePath: path.resolve(retiredStorePath),
            store: { "agent:old:main": { sessionId: "sess-retired-cross-root" } },
          },
        },
      ]);
    });
  });

  test("resolveGatewaySessionStoreTarget ignores a retired legacy store without provisioning SQLite", async () => {
    await withStateDirEnv("session-utils-retired-legacy-", async ({ stateDir }) => {
      const retiredSessionsDir = path.join(stateDir, "agents", "retired", "sessions");
      const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
      fs.mkdirSync(retiredSessionsDir, { recursive: true });
      fs.writeFileSync(
        retiredStorePath,
        JSON.stringify({
          "agent:retired:main": { sessionId: "sess-retired-legacy", updatedAt: 1 },
        }),
        "utf8",
      );
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: "agent:retired:main",
      });

      expect(target.storePath).toBe(retiredStorePath);
      expect(target.store).toEqual({});
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(retiredStorePath, {
        agentId: "retired",
      }).path;
      expect(sqlitePath).toBeDefined();
      expect(fs.existsSync(sqlitePath!)).toBe(false);
      expect(fs.readdirSync(retiredSessionsDir)).toEqual(["sessions.json"]);
      expect(
        prepareGatewaySessionStoreTargetsReadOnly({
          cfg,
          targets: [{ key: "agent:retired:main" }],
          projection: "list",
        }),
      ).toMatchObject([{ ok: true, value: { storePath: retiredStorePath, store: {} } }]);
      expect(fs.existsSync(sqlitePath!)).toBe(false);
    });
  });

  test("loadGatewaySessionEntryReadOnly does not materialize a missing configured agent", async () => {
    await withConfiguredStateDir("session-utils-load-entry-read-only-", async ({ stateDir }) => {
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }, { id: "missing" }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      const loaded = loadGatewaySessionEntryReadOnly("agent:missing:main");

      expect(loaded.entry).toBeUndefined();
      expect(fs.existsSync(path.join(stateDir, "agents", "missing"))).toBe(false);
    });
  });

  test("loadGatewaySessionEntryReadOnly discovers stores once but reads changed rows live", async () => {
    await withConfiguredStateDir("session-utils-request-discovery-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const cfg = {
        session: { mainKey: "main", store: storePath },
        agents: { entries: { main: {} } },
      } satisfies OpenClawConfig;
      const sessionKey = "agent:main:main";
      seedSessionEntries(storePath, {
        [sessionKey]: { sessionId: "session-before", updatedAt: 1 },
      });
      setRuntimeConfigSnapshot(cfg, cfg);
      const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
      const discoveryWrites = vi.spyOn(targetDiscoveryCache, "set");
      try {
        const first = loadGatewaySessionEntryReadOnly(sessionKey, { targetDiscoveryCache });
        await replaceSessionEntry(
          { sessionKey, storePath },
          { sessionId: "session-after", updatedAt: 2 },
        );
        const second = loadGatewaySessionEntryReadOnly(sessionKey, { targetDiscoveryCache });

        expect(first.entry?.sessionId).toBe("session-before");
        expect(second.entry?.sessionId).toBe("session-after");
        expect(targetDiscoveryCache.size).toBe(1);
        expect(discoveryWrites).toHaveBeenCalledTimes(1);
      } finally {
        discoveryWrites.mockRestore();
      }
    });
  });

  test("loadGatewaySessionEntryReadOnly clones only the selected row and direct children", async () => {
    await withConfiguredStateDir("session-utils-exact-read-only-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const cfg = {
        session: { mainKey: "main", store: storePath },
        agents: { list: [{ id: "main", default: true }] },
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
      const cloneSpy = vi.spyOn(globalThis, "structuredClone");
      try {
        expect(loadGatewaySessionEntryReadOnly(childKey, { clone: false }).entry).toMatchObject({
          sessionId: "child",
          spawnedBy: parentKey,
        });
        expect(
          listSessionChildEntriesReadOnly({
            agentId: "main",
            clone: false,
            sessionKey: parentKey,
            storePath,
          }).map((item) => item.sessionKey),
        ).toEqual([childKey]);
        const loaded = loadGatewaySessionEntryReadOnly("main", {
          includeStoreChildEntries: true,
        });

        expect(loaded.entry?.sessionId).toBe("parent");
        expect(Object.keys(loaded.store).toSorted()).toEqual([childKey, parentKey]);
        expect(loaded.entry).not.toBe(loaded.store[parentKey]);
        expect(cloneSpy).toHaveBeenCalledTimes(1);
      } finally {
        cloneSpy.mockRestore();
      }
    });
  });

  test("loadGatewaySessionEntryReadOnly rejects a persisted main alias", async () => {
    await withConfiguredStateDir("session-utils-exact-alias-children-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const cfg = {
        session: { mainKey: "work", store: storePath },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      const legacyParentKey = "agent:main:main";
      const childKey = "agent:main:child";
      const now = Date.now();
      seedSessionEntries(storePath, {
        [legacyParentKey]: { sessionId: "parent", updatedAt: now },
        [childKey]: {
          sessionId: "child",
          spawnedBy: legacyParentKey,
          updatedAt: now + 1,
        },
      });
      setRuntimeConfigSnapshot(cfg, cfg);

      expect(() =>
        loadGatewaySessionEntryReadOnly("main", {
          clone: false,
          includeStoreChildEntries: true,
        }),
      ).toThrow("openclaw doctor --fix");
      expect(
        prepareGatewaySessionStoreTargetsReadOnly({
          cfg,
          targets: [{ key: "main" }],
          projection: "list",
        }),
      ).toMatchObject([
        { ok: false, error: { message: expect.stringContaining("openclaw doctor --fix") } },
      ]);
    });
  });

  test("resolveGatewaySessionStoreTargetWithStore returns the caller-provided store", async () => {
    await withConfiguredStateDir("session-utils-target-store-", async ({ stateDir }) => {
      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      const store: Record<string, SessionEntry> = {
        "agent:main:main": { sessionId: "sess-main", updatedAt: 7 },
      };

      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: "agent:main:main",
        store,
      });

      expect(target.store).toBe(store);
      expect(target.storeKeys).toContain("agent:main:main");
    });
  });

  test.each(["research"])(
    "keeps private deleted-main discovery ahead of replacement selection (%s)",
    async (agentId) => {
      resetConfigRuntimeState();
      try {
        await withStateDirEnv("session-utils-load-deleted-main-entry-", async ({ stateDir }) => {
          const storeTemplate = path.join(
            stateDir,
            "agents",
            "{agentId}",
            "sessions",
            "sessions.json",
          );
          const liveSessionsDir = path.join(stateDir, "agents", "ops", "sessions");
          const deletedSessionsDir = path.join(stateDir, "agents", "main", "sessions");
          fs.mkdirSync(liveSessionsDir, { recursive: true });
          fs.mkdirSync(deletedSessionsDir, { recursive: true });
          const liveStorePath = path.join(liveSessionsDir, "sessions.json");
          const deletedStorePath = path.join(deletedSessionsDir, "sessions.json");
          seedSessionEntries(liveStorePath, {
            "agent:ops:main": { sessionId: "sess-live-default", updatedAt: 10 },
          });
          seedSessionEntries(deletedStorePath, {
            "agent:main:main": { sessionId: "sess-deleted-main", updatedAt: 20 },
          });
          const cfg = {
            session: { store: storeTemplate },
            agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
          } as OpenClawConfig;
          setRuntimeConfigSnapshot(cfg, cfg);

          const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:main:main", agentId });
          const loaded = loadSessionEntry("agent:main:main", { agentId });

          expect(target.canonicalKey).toBe("agent:main:main");
          expect(target.agentId).toBe("main");
          expect(target.storePath).toBe(path.resolve(deletedStorePath));
          expect(loaded.canonicalKey).toBe("agent:main:main");
          expect(loaded.storePath).toBe(path.resolve(deletedStorePath));
          expect(loaded.entry?.sessionId).toBe("sess-deleted-main");
          closeOpenClawAgentDatabasesForTest();
          const parse = JSON.parse;
          let liveDefaultParses = 0;
          const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
            if (text.includes('"sessionId":"sess-live-default"')) {
              liveDefaultParses += 1;
            }
            return parse(text, reviver);
          });
          try {
            expect(
              prepareGatewaySessionStoreTargetsReadOnly({
                cfg,
                targets: [{ key: "agent:main:main", agentId }],
                projection: "list",
              }),
            ).toMatchObject([
              {
                ok: true,
                value: {
                  agentId: "main",
                  storePath: path.resolve(deletedStorePath),
                  store: { "agent:main:main": { sessionId: "sess-deleted-main" } },
                },
              },
            ]);
            expect(liveDefaultParses).toBe(0);
          } finally {
            parseSpy.mockRestore();
          }
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
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        const key = "agent:main:dashboard:incognito-retired-owner";
        seedSessionEntries(storePath, {
          "agent:main:main": { sessionId: "durable-main", updatedAt: 1 },
          [key]: { sessionId: "incognito-owner", updatedAt: 1, incognito: true },
        });
        const cfg = {
          session: {
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "ops", default: true }] },
        } as OpenClawConfig;
        for (const requestedKey of [key, "agent:main:dashboard:incognito-missing"]) {
          const target = resolveGatewaySessionStoreTargetWithStore({
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
          const [prepared] = prepareGatewaySessionStoreTargetsReadOnly({
            cfg,
            targets: [{ key: requestedKey }],
            projection: "list",
          });
          if (!prepared?.ok) {
            throw new Error("Expected prepared incognito lookup to succeed");
          }
          const batched = prepared.value;
          expect(batched).toMatchObject({
            storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
            storeKeys: [requestedKey],
          });
          expect(batched?.store[requestedKey]?.sessionId).toBe(
            requestedKey === key ? "incognito-owner" : undefined,
          );
          expect(batched?.store["agent:main:main"]).toBeUndefined();
        }
      });
    },
  );

  test("loadSessionEntry rejects deleted main aliases when mainKey is customized", async () => {
    await withConfiguredStateDir("session-utils-load-deleted-main-alias-", async ({ stateDir }) => {
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
      const liveSessionsDir = path.join(stateDir, "agents", "ops", "sessions");
      const deletedSessionsDir = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(liveSessionsDir, { recursive: true });
      fs.mkdirSync(deletedSessionsDir, { recursive: true });
      seedSessionEntries(path.join(liveSessionsDir, "sessions.json"), {
        "agent:ops:work": { sessionId: "sess-live-default", updatedAt: 10 },
      });
      const deletedStorePath = path.join(deletedSessionsDir, "sessions.json");
      seedSessionEntries(deletedStorePath, {
        "agent:main:main": { sessionId: "sess-deleted-main", updatedAt: 20 },
      });
      const cfg = {
        session: { mainKey: "work", store: storeTemplate },
        agents: { list: [{ id: "ops", default: true }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      expect(() => loadSessionEntry("agent:main:work")).toThrow("openclaw doctor --fix");
      expect(
        prepareGatewaySessionStoreTargetsReadOnly({
          cfg,
          targets: [{ key: "agent:main:work" }],
          projection: "list",
        }),
      ).toMatchObject([
        { ok: false, error: { message: expect.stringContaining("openclaw doctor --fix") } },
      ]);
    });
  });
  test("loadSessionEntry keeps the configured canonical store authoritative", async () => {
    await withConfiguredStateDir("session-utils-load-entry-cross-store-", async ({ stateDir }) => {
      const canonicalSessionsDir = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(canonicalSessionsDir, { recursive: true });
      seedSessionEntries(path.join(canonicalSessionsDir, "sessions.json"), {
        "agent:main:main": { sessionId: "sess-canonical-fresh", updatedAt: 1000 },
      });

      const discoveredSessionsDir = path.join(stateDir, "agents", "main ", "sessions");
      fs.mkdirSync(discoveredSessionsDir, { recursive: true });
      seedSessionEntries(path.join(discoveredSessionsDir, "sessions.json"), {
        "agent:main:main": { sessionId: "sess-discovered-mid", updatedAt: 500 },
      });

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      setRuntimeConfigSnapshot(cfg, cfg);

      const loaded = loadSessionEntry("agent:main:main");

      expect(loaded.entry?.sessionId).toBe("sess-canonical-fresh");
    });
  });

  test("resolveCanonicalGatewaySessionStoreKey rejects legacy aliases", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const store: Record<string, SessionEntry> = {
      "agent:ops:work": {
        sessionId: "sess-stale",
        updatedAt: 1,
      } as SessionEntry,
      "agent:ops:main": {
        sessionId: "sess-fresh",
        updatedAt: 2,
      } as SessionEntry,
    };

    expect(() =>
      resolveCanonicalGatewaySessionStoreKey({
        cfg,
        key: "agent:ops:main",
        store,
      }),
    ).toThrow("openclaw doctor --fix");
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

  test("listAgentsForGateway allows avatar symlinks that stay inside workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-inside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "avatars"), { recursive: true });
    const targetPath = path.join(workspace, "avatars", "actual.png");
    fs.writeFileSync(targetPath, "avatar", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(targetPath, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = await listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBe(
      `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
    );
  });

  test.each(["local", "data"])("keeps %s avatar bytes out of browser agent rows", async (kind) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-browser-avatar-"));
    onTestFinished(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const dataUrl = `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`;
    fs.writeFileSync(path.join(workspace, "avatar-link.png"), "avatar");
    const cfg = createSingleAgentAvatarConfig(workspace);
    if (kind === "data") {
      cfg.agents!.list![0]!.identity!.avatar = dataUrl;
    }
    const browser = await listAgentsForGateway(cfg, undefined, { httpAvatarBasePath: "/control" });
    expect(browser.agents[0]?.identity?.avatarUrl).toMatch(
      /^\/control\/avatar\/main\?v=[a-f0-9]+$/,
    );
    expect(browser.agents[0]?.identity?.avatar).toBe(browser.agents[0]?.identity?.avatarUrl);
    expect(JSON.stringify(browser)).not.toContain(dataUrl);
    expect((await listAgentsForGateway(cfg)).agents[0]?.identity?.avatarUrl).toBe(dataUrl);
  });

  test("listAgentsForGateway keeps explicit agents.list scope over disk-only agents (scope boundary)", async () => {
    await withStateDirEnv("openclaw-agent-list-scope-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "main"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "codex"), { recursive: true });

      const cfg = {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const { agents } = await listAgentsForGateway(cfg);
      expect(agents.map((agent) => agent.id)).toEqual(["main"]);
    });
  });

  test("listAgentsForGateway preserves canonical roster kinds", async () => {
    await withStateDirEnv("openclaw-agent-list-kinds-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "openclaw"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "research"), { recursive: true });

      const result = await listAgentsForGateway({}, undefined, { includeSystem: true });

      expect(result.agents.map(({ id, kind }) => ({ id, kind }))).toEqual([
        { id: "main", kind: "agent" },
        { id: "openclaw", kind: "system" },
        { id: "research", kind: "agent" },
      ]);
    });
  });

  test("listAgentsForGateway keeps system agents out of the legacy response", async () => {
    await withStateDirEnv("openclaw-agent-list-legacy-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "openclaw"), { recursive: true });

      const agents = (await listAgentsForGateway({})).agents;
      expect(agents.map((agent) => agent.id)).toEqual(["main"]);
      expect(agents[0]).not.toHaveProperty("kind");
    });
  });

  test.each([
    [{ mode: "full" }, { mode: "ask" }, "guarded"],
    [{ security: "full", ask: "on-miss" }, undefined, undefined],
    [{ security: "deny", ask: "on-miss" }, undefined, undefined],
  ] as const)(
    "listAgentsForGateway labels global %j plus agent %j as %s",
    async (globalExec, agentExec, expected) => {
      await withAgentPermissionState(async () => {
        const cfg: OpenClawConfig = {
          tools: { exec: globalExec },
          agents: { entries: { main: { tools: { exec: agentExec } } } },
        };
        const original = structuredClone(cfg);
        const agent = (await listAgentsForGateway(cfg)).agents.find((entry) => entry.id === "main");
        if (expected === undefined) {
          expect(agent).not.toHaveProperty("defaultPermissionMode");
        } else {
          expect(agent).toHaveProperty("defaultPermissionMode", expected);
          const resolved = resolveExecDefaults({ cfg, agentId: "main" });
          expect(agent?.defaultPermissionMode).toBe(SESSION_PERMISSION_BY_EXEC_MODE[resolved.mode]);
        }
        expect(cfg).toEqual(original);
      });
    },
  );

  test.each<{
    name: string;
    cfg: OpenClawConfig;
    approvals: ExecApprovalsFile;
    expected: SessionEntry["permissionMode"];
  }>([
    {
      name: "auto tightened by approvals",
      cfg: { tools: { exec: { mode: "auto" } } },
      approvals: { version: 1, defaults: { security: "deny", ask: "off" } },
      expected: undefined,
    },
    {
      name: "full tightened by approvals",
      cfg: { tools: { exec: { mode: "full" } } },
      approvals: { version: 1, defaults: { security: "deny", ask: "off" } },
      expected: "read-only",
    },
    {
      name: "global sandbox all",
      cfg: { agents: { defaults: { sandbox: { mode: "all" } } } },
      approvals: { version: 1 },
      expected: undefined,
    },
    {
      name: "agent disabling global sandbox",
      cfg: {
        tools: { exec: { mode: "ask" } },
        agents: {
          defaults: { sandbox: { mode: "all" } },
          entries: { main: { sandbox: { mode: "off" } } },
        },
      },
      approvals: { version: 1 },
      expected: "guarded",
    },
  ])("listAgentsForGateway never overstates $name", async ({ cfg, approvals, expected }) => {
    await withAgentPermissionState(async () => {
      saveExecApprovals(approvals);
      const agent = (await listAgentsForGateway(cfg)).agents.find((entry) => entry.id === "main");
      expect(agent).toBeDefined();
      if (expected === undefined) {
        expect(agent).not.toHaveProperty("defaultPermissionMode");
      } else {
        expect(agent).toHaveProperty("defaultPermissionMode", expected);
      }
      for (const sessionKey of ["agent:main:main", "agent:main:other"]) {
        const resolved = resolveExecDefaults({ cfg, agentId: "main", sessionKey });
        expect([undefined, SESSION_PERMISSION_BY_EXEC_MODE[resolved.mode]]).toContain(
          agent?.defaultPermissionMode,
        );
      }
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
      const loadApprovals = vi.spyOn(execApprovalsStore, "loadExecApprovalsReadOnlyAsync");
      onTestFinished(() => loadApprovals.mockRestore());
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
      expect(loadApprovals).toHaveBeenCalledTimes(1);
    });
  });

  test("listAgentsForGateway respects per-agent fallback override (including explicit empty list)", async () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [
          { id: "main", default: true },
          {
            id: "ops",
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: [],
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = await listAgentsForGateway(cfg);
    const ops = result.agents.find((agent) => agent.id === "ops");
    expect(ops?.model).toEqual({ primary: "anthropic/claude-opus-4-6" });
  });

  test("listAgentsForGateway uses the model catalog for per-agent thinking metadata", async () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          model: { primary: "local/custom-reasoner" },
        },
        list: [{ id: "main", default: true }, { id: "work" }, { id: "missing" }],
      },
    } as OpenClawConfig;
    const catalogEntry = {
      provider: "local",
      id: "custom-reasoner",
      name: "Custom Reasoner",
    };
    const disabledCatalog = [{ ...catalogEntry, reasoning: false }];
    const enabledCatalog = [{ ...catalogEntry, reasoning: true }];

    const result = await listAgentsForGateway(cfg, disabledCatalog, {
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
              primary: "clawrouter/openai/gpt-5.6",
              fallbacks: ["openai/gpt-5.6-luna"],
            },
            models: {
              "openai/gpt-5.6-sol": {
                alias: "clawrouter/openai/gpt-5.6",
                agentRuntime: { id: "codex" },
              },
            },
          },
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;
      const catalog = [
        {
          provider: "openai",
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          reasoning: true,
        },
      ];

      const agent = (await listAgentsForGateway(cfg, catalog)).agents[0];

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

  test("caps transcript title and last-message hydration for bulk list responses", async () => {
    const storePath = fixtureStorePath();
    const store: Record<string, SessionEntry> = {};
    const now = Date.now();
    for (let i = 0; i < 101; i += 1) {
      const sessionId = `sess-${i}`;
      const sessionKey = `agent:main:${sessionId}`;
      const entry = {
        sessionId,
        updatedAt: now - i,
        modelProvider: "openai",
        model: "gpt-5.4",
      } as SessionEntry;
      store[sessionKey] = entry;
      seedSessionEntries(storePath, {
        [sessionKey]: entry,
      });
      if (i === 0 || i === 99 || i === 100) {
        appendTranscriptMessages({
          sessionId,
          sessionKey,
          storePath,
          messages: [
            { role: "user", content: `title ${i}` },
            { role: "assistant", content: `last ${i}` },
          ],
        });
      }
    }

    const result = await listSessionFixture({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath,
      store,
      opts: { includeDerivedTitles: true, includeLastMessage: true, limit: 101 },
    });

    expect(result.sessions).toHaveLength(101);
    expect(result.sessions[0]?.derivedTitle).toBe("Title 0");
    expect(result.sessions[0]?.lastMessagePreview).toBe("last 0");
    expect(result.sessions[99]?.derivedTitle).toBe("Title 99");
    expect(result.sessions[99]?.lastMessagePreview).toBe("last 99");
    expect(result.sessions[100]?.derivedTitle).toBeUndefined();
    expect(result.sessions[100]?.lastMessagePreview).toBeUndefined();
  });

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
        global: { sessionId: "global", updatedAt: now } as SessionEntry,
      },
      opts: { agentId: "work", includeGlobal: true, search: "claude-opus" },
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: "global",
      agentId: "work",
      modelProvider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  test("filters phantom agent store placeholder rows from session lists", async () => {
    const now = Date.now();
    const result = await listSessionFixture({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: fixtureStorePath(),
      store: {
        "agent:main:sessions": {} as SessionEntry,
        "agent:main:main": { sessionId: "sess-main", updatedAt: now } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:main"]);
  });
});

describe("deriveSessionTitle", () => {
  test("returns undefined for undefined entry", () => {
    expect(deriveSessionTitle(undefined)).toBeUndefined();
  });

  test("keeps a derived title valid when the limit bisects an emoji", () => {
    const entry = { sessionId: "abc123", updatedAt: Date.now() } as SessionEntry;
    expect(deriveSessionTitle(entry, `${"t".repeat(58)}🚀 extra`)).toBe(
      `${"T".repeat(1)}${"t".repeat(57)}…`,
    );
  });

  test("leaves a failed dashboard thread untitled so the UI can render New thread", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: new Date("2024-03-15T10:30:00Z").getTime(),
    } as SessionEntry;

    expect(deriveSessionTitle(entry)).toBeUndefined();
    expect(deriveSessionTitle(entry, "")).toBeUndefined();
    expect(deriveSessionTitle(entry, "   ")).toBeUndefined();
  });

  test("prefers a trimmed displayName over the subject", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "  Padded Name  ",
      subject: "Group Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Padded Name");
  });

  test.each([
    {
      name: "prefers an explicit label over display and group metadata",
      fields: {
        displayName: "Display Name",
        subject: "Group Subject",
        label: "Label via /name",
      },
      firstUserMessage: "Hello, what can you do?",
      expected: "Label via /name",
    },
    {
      name: "ignores a blank label",
      fields: { label: "   " },
      firstUserMessage: "Hello!",
      expected: "Hello!",
    },
  ])("$name", ({ fields, firstUserMessage, expected }) => {
    const entry = { sessionId: "abc123", updatedAt: Date.now(), ...fields } as SessionEntry;
    expect(deriveSessionTitle(entry, firstUserMessage)).toBe(expected);
  });
});

describe("resolveGatewayModelSupportsImages", () => {
  type Model = GatewayModelCatalogSnapshot["entries"][number];
  const vision: Model = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    input: ["text", "image"],
  };
  const query = { agentId: "qa", model: vision.id, provider: vision.provider };
  const snapshot = (
    overrides: Partial<GatewayModelCatalogSnapshot> = {},
  ): GatewayModelCatalogSnapshot => ({
    agentId: "qa",
    agentDir: "/tmp/gateway-model-capability-agent",
    workspaceDir: "/tmp/gateway-model-capability-workspace",
    catalogComplete: false,
    config: {},
    entries: [],
    routeVariants: [],
    ...overrides,
  });
  const preparedSupport = (
    prepared: GatewayModelCatalogSnapshot,
    provider: string | undefined = "openai",
  ) =>
    resolveGatewayModelSupportsImages({
      ...query,
      provider,
      loadGatewayModelCatalog: async () => [],
      loadGatewayModelCatalogSnapshot: async () => prepared,
    });

  test("uses prepared Sol capabilities without starting full catalog discovery", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => []);
    const loadGatewayModelCatalogSnapshot = vi.fn(async (params?: { readOnly?: boolean }) => {
      if (params?.readOnly !== true) {
        throw new Error("full catalog discovery must not start during attachment admission");
      }
      return snapshot({ staticEntries: [{ ...vision, id: "gpt-5.6-sol" }] });
    });
    await expect(
      resolveGatewayModelSupportsImages({
        ...query,
        model: "gpt-5.6-sol",
        loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot,
      }),
    ).resolves.toBe(true);
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({ agentId: "qa", readOnly: true });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "discovers live capabilities when provisional metadata is text-only=%s",
    async (textOnly) => {
      const model: Model = {
        id: "vendor/runtime-vision-model",
        name: "Runtime Vision Model",
        provider: "openrouter",
        input: ["text", "image"],
      };
      const loadGatewayModelCatalogSnapshot = vi.fn(async (params?: { readOnly?: boolean }) =>
        snapshot({
          entries: params?.readOnly ? (textOnly ? [{ ...model, input: ["text"] }] : []) : [model],
        }),
      );
      await expect(
        resolveGatewayModelSupportsImages({
          ...query,
          model: model.id,
          provider: model.provider,
          loadGatewayModelCatalog: async () => [],
          loadGatewayModelCatalogSnapshot,
        }),
      ).resolves.toBe(true);
      expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(1, {
        agentId: "qa",
        readOnly: true,
      });
      expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(2, {
        agentId: "qa",
        readOnly: false,
      });
    },
  );

  test.each([false, true])(
    "does not rediscover a complete catalog with a text-only row=%s",
    async (hasRow) => {
      const modes: Array<boolean | undefined> = [];
      await expect(
        resolveGatewayModelSupportsImages({
          agentId: "qa",
          model: "vendor/runtime-text-model",
          provider: "openrouter",
          loadGatewayModelCatalog: async () => [],
          loadGatewayModelCatalogSnapshot: async (params) => {
            modes.push(params?.readOnly);
            if (params?.readOnly !== true) {
              throw new Error("full catalog discovery must not restart for a complete owner");
            }
            return snapshot({
              catalogComplete: true,
              entries: hasRow
                ? [
                    {
                      id: "vendor/runtime-text-model",
                      name: "Text",
                      provider: "openrouter",
                      input: ["text"],
                    },
                  ]
                : [],
            });
          },
        }),
      ).resolves.toBe(false);
      expect(modes).toEqual([true]);
    },
  );

  test("repairs stale visible text-only metadata with same-agent static vision", async () => {
    await expect(
      preparedSupport(
        snapshot({ entries: [{ ...vision, input: ["text"] }], staticEntries: [vision] }),
      ),
    ).resolves.toBe(true);
  });

  test("does not borrow another agent's static image capabilities", async () => {
    await expect(
      preparedSupport(snapshot({ agentId: "other", staticEntries: [vision] })),
    ).resolves.toBe(false);
  });

  test("does not override explicitly configured text-only input with static vision", async () => {
    const modes: Array<boolean | undefined> = [];
    await expect(
      resolveGatewayModelSupportsImages({
        ...query,
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async (params) => {
          modes.push(params?.readOnly);
          return snapshot({
            config: {
              models: {
                providers: {
                  openai: {
                    baseUrl: "https://api.openai.com/v1",
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
            entries: [{ ...vision, baseUrl: "https://api.openai.com/v1", input: ["text"] }],
            staticEntries: [{ ...vision, baseUrl: "https://api.openai.com/v1" }],
          });
        },
      }),
    ).resolves.toBe(false);
    expect(modes).toEqual([true]);
  });

  test("does not borrow static image capabilities across configured routes", async () => {
    await expect(
      preparedSupport(
        snapshot({
          config: {
            models: {
              providers: { openai: { baseUrl: "https://custom.example.test/v1", models: [] } },
            },
          },
          staticEntries: [{ ...vision, baseUrl: "https://api.openai.com/v1" }],
        }),
      ),
    ).resolves.toBe(false);
  });

  test.each([
    { route: "API", api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
    { route: "base URL", api: "openai-responses", baseUrl: "https://custom.example.test/v1" },
  ] as const)(
    "does not borrow static vision across a mismatched visible $route",
    async ({ api, baseUrl }) => {
      await expect(
        preparedSupport(
          snapshot({
            entries: [{ ...vision, api, baseUrl, input: ["text"] }],
            staticEntries: [
              { ...vision, api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
            ],
          }),
        ),
      ).resolves.toBe(false);
    },
  );

  test("fails closed on providerless static image capabilities", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "shared-vision",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          snapshot({
            staticEntries: [
              { ...vision, id: "shared-vision", provider: "first" },
              { ...vision, id: "shared-vision", provider: "second" },
            ],
          }),
      }),
    ).resolves.toBe(false);
  });

  test("fails closed without a stale catalog when the prepared snapshot fails", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => [vision]);
    await expect(
      resolveGatewayModelSupportsImages({
        ...query,
        loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot: async () => {
          throw new Error("prepared catalog unavailable");
        },
      }),
    ).resolves.toBe(false);
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  test.each([
    {
      model: "deployment-gpt5",
      provider: "microsoft-foundry",
      entry: {
        id: "deployment-gpt5",
        name: "gpt-5.4",
        provider: "microsoft-foundry",
        input: ["text"],
      },
    },
    {
      model: "claude-sonnet-4-6",
      provider: "claude-cli",
      entry: {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "claude-cli",
        input: ["text"],
      },
    },
    {
      model: "Qwen/Qwen3.5-35B-A3B",
      provider: undefined,
      entry: {
        id: "qwen/qwen3.5-35b-a3b",
        name: "Qwen3.5 35B",
        provider: "modelscope",
        input: ["text", "image"],
      },
    },
  ] satisfies Array<{ model: string; provider?: string; entry: Model }>)(
    "resolves legacy or providerless vision for $model",
    async ({ model, provider, entry }) => {
      await expect(
        resolveGatewayModelSupportsImages({
          model,
          provider,
          loadGatewayModelCatalog: async () => [entry],
        }),
      ).resolves.toBe(true);
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
