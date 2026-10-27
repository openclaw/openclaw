import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it as baseIt, vi } from "vitest";
// Register shared mocks before imports bind their production exports.
import "./agent-command.test-mocks.js";
import "./agent-command-attempt.test-mocks.js";
import { testing as acpManagerTesting } from "../acp/control-plane/manager.js";
import { executionIdentity } from "../agents/agent-command-execution-identity.js";
import { createHostWorkspaceWriteTool } from "../agents/agent-tools.read.js";
import * as authProfileStoreModule from "../agents/auth-profiles/store-runtime.js";
import * as attemptExecutionRuntime from "../agents/command/attempt-execution.runtime.js";
import { deliverAgentCommandResult } from "../agents/command/delivery.runtime.js";
import { prepareAgentCommandExecution } from "../agents/command/prepare.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { loadManifestModelCatalog } from "../agents/model-catalog.js";
import * as modelSelectionModule from "../agents/model-selection.js";
import {
  loadProviderScopedThinkingCatalog,
  readPreparedModelCatalog,
} from "../agents/prepared-model-catalog.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
} from "../agents/run-termination.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { callInProcessGatewayTool } from "../agents/tools/in-process-gateway.js";
import type * as AgentWorkspaceModule from "../agents/workspace.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { BASE_THINKING_LEVELS } from "../auto-reply/thinking.shared.js";
import {
  readAgentRunTerminalError,
  readAgentRunTerminalOutcome,
} from "../channels/turn/agent-run-terminal-outcome.js";
import * as runtimeSnapshotModule from "../config/runtime-snapshot.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  addSessionMember,
  readSessionMembersInWorker,
} from "../config/sessions/session-sharing-store.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getBootEchoContextForSession } from "../gateway/boot-echo-guard.js";
import { runBootOnce } from "../gateway/boot.js";
import { emitAgentEvent, onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { useBundledProviderPolicyArtifactsForTest } from "../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginProviderRegistration } from "../plugins/registry.test-fixtures.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../sessions/agent-harness-session-key.js";
import { interruptSessionControllerEffects } from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveEffectiveAgentSkillFilter } from "../skills/discovery/agent-filter.js";
import {
  loadVisibleSkills,
  loadWorkspaceSkills,
} from "../skills/loading/workspace-skill-loader.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../skills/runtime/session-snapshot.js";
import type { SkillEntry } from "../skills/types.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { getAgentAttemptExecutionMocks } from "./agent-command-state.test-mocks.js";
import {
  createDefaultAgentResult,
  createOutboundSessionRouteFixture,
  expectOwnedCommandSession,
  readSessionStore,
  useRealCommandSessionPersistence,
  withAgentCommandTestHome as withTempHome,
  writeSessionStoreSeed,
} from "./agent-session.test-support.js";
import { agentCommand, agentCommandFromIngress } from "./agent.js";
import { registerAgentReplyPolicyTests } from "./agent.reply-policy.test-support.js";
import { registerAgentStoredOverrideTests } from "./agent.stored-override.test-support.js";
import { registerAgentThinkingTests } from "./agent.thinking.test-support.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const configIoMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

// mock-isolation: Command fixtures supply in-memory runtime/source config instead of persisted config.
vi.mock("../config/io.js", () => ({
  captureRuntimeConfigAsyncReader: () => async () => configIoMocks.loadConfig(),
  getRuntimeConfig: configIoMocks.loadConfig,
  loadConfig: configIoMocks.loadConfig,
  readConfigFileSnapshotForWrite: configIoMocks.readConfigFileSnapshotForWrite,
}));

// mock-isolation: Command fixtures use an empty credential map instead of host auth state.
vi.mock("../agents/auth-profiles/store-runtime.js", () => {
  const createEmptyStore = () => ({ version: 1, profiles: {} });
  return {
    ensureAuthProfileStore: vi.fn(createEmptyStore),
    ensureAuthProfileStoreAsync: vi.fn(async () => createEmptyStore()),
    ensureAuthProfileStoreForLocalUpdateAsync: vi.fn(async () => createEmptyStore()),
    ensureAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(async () => createEmptyStore()),
    ensureAuthProfileStoreForLocalUpdate: vi.fn(createEmptyStore),
    loadAuthProfileStore: vi.fn(createEmptyStore),
    loadAuthProfileStoreForRuntime: vi.fn(createEmptyStore),
    loadAuthProfileStoreForRuntimeAsync: vi.fn(async () => createEmptyStore()),
    loadAuthProfileStoreForSecretsRuntime: vi.fn(createEmptyStore),
    loadAuthProfileStoreWithoutExternalProfiles: vi.fn(createEmptyStore),
    loadAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(async () => createEmptyStore()),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => createEmptyStore()),
  };
});

// mock-isolation: Command fixtures supply an empty auth store; source discovery must not read host credentials.
vi.mock("../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: vi.fn(() => false),
}));

// mock-isolation: ordinary command fixtures forward a prepared reply mode without loading session and harness policy state.
vi.mock("../auto-reply/reply/session-stable-reply-mode.js", () => ({
  resolveSessionStableReplyMode: vi.fn(async () => "automatic"),
}));

vi.mock("../agents/harness/selection.js", () => ({
  // Availability fallback is covered in selection.test.ts.
  resolveAvailableAgentHarnessPolicy: vi.fn(() => ({
    runtime: "openclaw",
    runtimeSource: "implicit",
  })),
}));

vi.mock("../agents/harness/hook-helpers.js", () => ({
  // No command fixture registers tool or transcript hooks.
  runAgentHarnessAfterToolCallHook: vi.fn(async () => undefined),
  runAgentHarnessBeforeMessageWriteHook: ({ message }: { message: unknown }) => message,
}));

// mock-isolation: Command cases own model metadata; runtime catalog hydration is tested separately.
vi.mock("../agents/thinking-runtime.js", () => {
  // Runtime selection is covered in thinking-runtime.test.ts.
  type Catalog = Array<{ id: string; provider: string; reasoning?: boolean }>;
  const hasEntry = (catalog: Catalog | undefined, provider: string, model: string) =>
    catalog?.some(
      (entry) =>
        entry.provider.toLowerCase() === provider.toLowerCase() &&
        entry.id === model &&
        entry.reasoning !== undefined,
    ) ?? false;
  return {
    hasResolvedThinkingCatalogEntry: (params: {
      catalog?: Catalog;
      provider: string;
      model: string;
    }) => hasEntry(params.catalog, params.provider, params.model),
    needsThinkHydration: (
      catalog: Catalog | undefined,
      provider: string,
      model: string,
      runtime: string,
    ) => runtime !== "openclaw" || !hasEntry(catalog, provider, model),
    normalizeThinkingCatalogProviders: <T extends { provider: string }>(catalog: T[]) =>
      catalog.map((entry) => ({ ...entry, provider: entry.provider.toLowerCase() })),
    resolveCandidateThinkingLevel: ({ level }: { level?: string }) => level,
    resolveEffectiveAgentRuntime: vi.fn(() => "openclaw"),
  };
});

vi.mock("../cli/command-secret-targets.js", () => ({
  // These fixtures contain no SecretRefs.
  getAgentRuntimeCommandSecretTargetIds: () => new Set<string>(),
  getAgentRuntimeOptionalCommandSecretPaths: () => new Set<string>(),
  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
}));

vi.mock("../infra/outbound/channel-bootstrap.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/outbound/channel-bootstrap.runtime.js")>()),
  // Channel fixtures are already active.
  bootstrapOutboundChannelPlugin: vi.fn(() => undefined),
  bootstrapOutboundChannelPluginAsync: vi.fn(() => undefined),
}));

vi.mock("../config/sessions/inbound.runtime.js", () => ({
  // Outbound-session tests own downstream route persistence.
  resolveSessionStorePathCore: vi.fn(() => ""),
  updateSessionLastRoute: vi.fn(async () => null),
}));

vi.mock("../agents/command/assistant-transcript-repair.js", () => ({
  // These fixtures have no pending transcript repairs.
  persistAssistantTranscriptRepairRecord: vi.fn(async () => undefined),
  repairPendingAssistantTranscriptTurns: vi.fn(async () => undefined),
}));

// mock-isolation: Command delivery fixtures record payloads without using live channel transports.
vi.mock("../agents/command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: vi.fn(
    async (
      params: Pick<
        Parameters<typeof deliverAgentCommandResult>[0],
        "runtime" | "opts" | "result" | "payloads"
      > & {
        deps: {
          telegram?: (to: string, text: string, opts: Record<string, unknown>) => Promise<unknown>;
        };
      },
    ) => {
      const payloads = params.payloads ?? [];
      const deliveryResult = { payloads, meta: params.result.meta ?? {} };
      if (params.opts.json) {
        params.runtime.log(JSON.stringify(deliveryResult));
        return deliveryResult;
      }
      if (params.opts.deliver && params.opts.channel === "telegram" && params.opts.to) {
        for (const payload of payloads) {
          await params.deps.telegram?.(params.opts.to, payload.text ?? "", {
            ...(payload.mediaUrl ? { mediaUrl: payload.mediaUrl } : {}),
            accountId: undefined,
            verbose: false,
          });
        }
        return deliveryResult;
      }
      for (const payload of payloads) {
        if (payload.text) {
          params.runtime.log(payload.text);
        }
      }
      return deliveryResult;
    },
  ),
}));

const attemptExecutionMocks = getAgentAttemptExecutionMocks();

const it = baseIt.extend<{ home: string; store: string; cfg: OpenClawConfig }>({
  home: async ({ task: _task }, use) => {
    await withTempHome(use);
  },
  store: async ({ home }, use) => {
    await use(path.join(home, "sessions.json"));
  },
  cfg: async ({ home, store }, use) => {
    await use(mockConfig(home, store));
  },
});
const runtime = createThrowingTestRuntime();
type CommandOpts = Parameters<typeof agentCommand>[0];
type IngressOpts = Parameters<typeof agentCommandFromIngress>[0];
const runCommand = (opts: Omit<CommandOpts, "message"> & { message?: string }) =>
  agentCommand({ message: "hi", ...opts }, runtime);
const runIngress = (
  opts: Omit<IngressOpts, "message" | "allowModelOverride"> &
    Partial<Pick<IngressOpts, "message" | "allowModelOverride">>,
) => agentCommandFromIngress({ message: "hi", allowModelOverride: false, ...opts }, runtime);

async function seedSession(
  store: string,
  key: string,
  entry: Parameters<typeof writeSessionStoreSeed>[1][string],
) {
  await writeSessionStoreSeed(store, { [key]: entry });
}

async function useRealDelivery() {
  const { deliverAgentCommandResult: deliver } = await vi.importActual<
    typeof import("../agents/command/delivery.js")
  >("../agents/command/delivery.js");
  vi.mocked(deliverAgentCommandResult).mockImplementationOnce(deliver);
}

async function useRealWorkspace() {
  const actual = await vi.importActual<typeof AgentWorkspaceModule>("../agents/workspace.js");
  vi.mocked(ensureAgentWorkspace).mockImplementationOnce(actual.ensureAgentWorkspace);
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args]);
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  agentEntries?: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>,
) {
  const cfg = {
    meta: { migrations: { modelPolicyAllowlist: true } },
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
        ...agentOverrides,
      },
      entries: agentEntries,
      ...(Object.keys(agentEntries ?? {}).length > 1 ? { ownership: "explicit" as const } : {}),
    },
    session: { store: storePath, mainKey: "main" },
    channels: { telegram: undefined },
  } as OpenClawConfig;
  configIoMocks.loadConfig.mockReturnValue(cfg);
  return cfg;
}

function mockUserInvocableSkills(home: string, names: string[]) {
  const entries = names.map((name) => {
    const baseDir = path.join(home, "openclaw", "skills", name);
    const filePath = path.join(baseDir, "SKILL.md");
    return {
      skill: {
        name,
        description: `${name} instructions`,
        filePath,
        baseDir,
        source: "openclaw-workspace",
        sourceInfo: {
          path: filePath,
          source: "openclaw-workspace",
          scope: "project",
          origin: "top-level",
        },
        disableModelInvocation: false,
      },
      frontmatter: {},
      invocation: { userInvocable: true, disableModelInvocation: false },
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: true,
        userInvocable: true,
      },
    } satisfies SkillEntry;
  });
  vi.mocked(loadVisibleSkills).mockImplementation((_workspaceDir, opts) => {
    const filter = opts?.skillFilter;
    return filter === undefined
      ? entries
      : entries.filter((entry) => filter.includes(entry.skill.name));
  });
  vi.mocked(loadWorkspaceSkills).mockReturnValue(entries);
}

function getLastEmbeddedCall() {
  return vi.mocked(runEmbeddedAgent).mock.calls.at(-1)?.[0];
}

function expectSessionTarget(storePath: string, sessionKey: string, agentId = "ops") {
  const call = getLastEmbeddedCall();
  const sessionId = expectDefined(call?.sessionId, "embedded session id");
  expect(sessionId).toBeTruthy();
  expect(call).toMatchObject({ agentId, sessionKey, sessionFile: sessionKey });
  expect(
    vi.mocked(attemptExecutionRuntime.runAgentAttempt).mock.calls.at(-1)?.[0].sessionTarget,
  ).toEqual({ agentId, sessionId, sessionKey, storePath });
  return sessionId;
}

function expectOpsSession(storePath: string, sessionKey: string, sessionId: string) {
  expectOwnedCommandSession({
    agentId: "ops",
    excludedAgentId: "main",
    sessionKey,
    sessionId,
    storePath,
  });
}

function expectLastRunProviderModel(provider: string, model: string): void {
  expect(getLastEmbeddedCall()).toMatchObject({ provider, model });
}

function expectModelAttempts(expected: Array<{ provider: string; model: string }>) {
  expect(
    vi.mocked(runEmbeddedAgent).mock.calls.map(([call]) => ({
      provider: call.provider,
      model: call.model,
    })),
  ).toEqual(expected);
}

function mockModelCatalogOnce(entries: ReturnType<typeof loadManifestModelCatalog>): void {
  // Startup ranking and turn selection share the captured manifest snapshot.
  vi.mocked(loadManifestModelCatalog).mockReturnValue(entries);
  vi.mocked(readPreparedModelCatalog).mockResolvedValueOnce(entries);
}

function installThinkingTestProviders(channels: Parameters<typeof createTestRegistry>[0] = []) {
  const registry = createTestRegistry(channels);
  registry.providers = ["anthropic", "codex", "ollama", "openai", "openrouter"].map(
    (providerId): PluginProviderRegistration => ({
      pluginId: providerId,
      source: "test",
      provider: {
        id: providerId,
        label: providerId,
        auth: [],
        resolveThinkingProfile: () => ({
          levels: BASE_THINKING_LEVELS.map((id) => ({ id })),
          defaultLevel: "off",
        }),
      },
    }),
  );
  setActivePluginRegistry(registry);
}

useBundledProviderPolicyArtifactsForTest(["openai", "anthropic", "xai"]);

beforeEach(() => {
  vi.clearAllMocks();
  attemptExecutionMocks.useRealRunAgentAttempt = false;
  resetPluginRuntimeStateForTest();
  installThinkingTestProviders();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest();
  acpManagerTesting.resetAcpSessionManagerForTests();
  runtimeSnapshotModule.clearRuntimeConfigSnapshot();
  vi.mocked(runEmbeddedAgent).mockResolvedValue(createDefaultAgentResult());
  vi.mocked(loadManifestModelCatalog).mockReturnValue([]);
  vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue([]);
  vi.mocked(readPreparedModelCatalog).mockResolvedValue([]);
  vi.mocked(resolveEffectiveAgentRuntime).mockReturnValue("openclaw");
  vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
  configIoMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  });
});

describe("agentCommand", () => {
  it("delivers a real local Gateway tool result through the normal CLI admission", async ({
    cfg: _cfg,
  }) => {
    // The synthetic provider substitutes inference only; command admission and RPC stay real.
    vi.mocked(runEmbeddedAgent).mockImplementationOnce(async () => {
      const identity = await callInProcessGatewayTool<{ agentId: string }>("agent.identity.get", {
        agentId: "main",
      });
      expect(identity).toMatchObject({ agentId: "main" });
      return createDefaultAgentResult({
        payloads: [{ text: `Local agent: ${identity.agentId}` }],
      });
    });
    await useRealDelivery();

    const result = await runCommand({ message: "Identify this local agent", agentId: "main" });

    expect(result?.payloads).toEqual([{ text: "Local agent: main", mediaUrl: null }]);
    expect(runtime.log).toHaveBeenCalledWith("Local agent: main");
    expect(readAgentRunTerminalOutcome(result)).toBe("completed");
  });

  it.for([false, true])(
    "runs BOOT.md with an existing SQLite boot session and cleans up after failure=%s",
    async (fail, { home, store: storePath }) => {
      const cfg = mockConfig(home, storePath, undefined, { main: {} });
      const workspaceDir = path.join(home, "openclaw");
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, "BOOT.md"), "Check status.");
      const priorScope = { storePath, sessionKey: "agent:main:boot", sessionId: "previous-boot" };
      await replaceSessionEntry(priorScope, {
        sessionId: priorScope.sessionId,
        updatedAt: Date.now(),
        label: "Previous boot",
        visibility: "read-only",
      });
      const transcript = [
        { type: "session", id: priorScope.sessionId, cwd: workspaceDir },
        {
          type: "message",
          id: "old-message",
          parentId: null,
          message: { role: "user", content: "Keep this history." },
        },
      ];
      await replaceTranscriptEvents(priorScope, transcript);
      const priorEntry = loadSessionEntry(priorScope);
      const { member } = await addSessionMember(priorScope, {
        identityId: "boot-history-reader",
        addedBy: "operator",
      });
      const bootSessions = new Map<string, string>();
      vi.mocked(runEmbeddedAgent).mockImplementation(async (params) => {
        const sessionKey = expectDefined(params.sessionKey, "boot session key");
        expect(params.sessionId).not.toBe(priorScope.sessionId);
        expect(getBootEchoContextForSession(sessionKey)).toContain("Check status.");
        bootSessions.set(sessionKey, params.sessionId);
        await replaceTranscriptEvents({ storePath, sessionKey, sessionId: params.sessionId }, [
          { type: "session", id: params.sessionId, cwd: workspaceDir },
        ]);
        if (fail) {
          throw new Error("boot runtime failed");
        }
        return createDefaultAgentResult();
      });

      for (let restart = 0; restart < 2; restart++) {
        const result = await runBootOnce({ cfg, deps: {}, workspaceDir });
        expect(result).toEqual(
          fail
            ? { status: "failed", reason: "agent run failed: boot runtime failed" }
            : { status: "ran" },
        );
        expect(vi.mocked(runEmbeddedAgent).mock.calls).toHaveLength(restart + 1);
        expect(loadSessionEntry(priorScope)).toEqual(priorEntry);
        expect(await loadTranscriptEvents(priorScope)).toEqual(transcript);
        expect((await readSessionMembersInWorker(priorScope)).members).toEqual([member]);
        expect(listSessionEntriesCore({ storePath }).map(({ sessionKey }) => sessionKey)).toEqual([
          priorScope.sessionKey,
        ]);
        for (const [sessionKey, sessionId] of bootSessions) {
          expect(getBootEchoContextForSession(sessionKey)).toBeUndefined();
          expect(await loadTranscriptEvents({ storePath, sessionKey, sessionId })).toEqual([]);
        }
      }
      expect(bootSessions.size).toBe(2);
    },
  );

  it.for([
    {
      name: "completed stop",
      meta: {
        stopReason: "stop",
        finalAssistantVisibleText: "ok",
        finalAssistantRawText: "ok",
        terminalReply: { disposition: "visible" as const, text: "ok" },
      },
      outcome: "completed",
    },
    {
      name: "structured blocked result",
      meta: {
        replayInvalid: true,
        livenessState: "blocked" as const,
        finalAssistantVisibleText: "Prompt exceeds model context",
        finalAssistantRawText: "Prompt exceeds model context",
        error: { kind: "context_overflow" as const, message: "Prompt exceeds model context" },
      },
      outcome: "failed",
    },
    {
      name: "provider timeout",
      meta: { aborted: true, stopReason: "timeout", timeoutPhase: "provider" as const },
      outcome: "failed",
    },
    { name: "yielded turn", meta: { yielded: true }, outcome: "completed" },
    {
      name: "exhausted fallback",
      meta: {
        error: {
          kind: "incomplete_turn" as const,
          message: "Incomplete terminal response",
          fallbackSafe: true,
          terminalPresentation: true,
        },
      },
      outcome: "failed",
    },
    { name: "callback error", meta: {}, outcome: "failed", fault: "callback" },
    { name: "late cancellation", meta: {}, outcome: "failed", fault: "abort" },
  ])(
    "hands off the terminal outcome after real delivery projection: $name",
    async ({ meta, outcome, fault }, { cfg: _cfg }) => {
      const controller = new AbortController();
      const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
      const text = meta.error?.message ?? "ok";
      const rawResult = {
        ...createDefaultAgentResult(),
        payloads: [{ text, ...(meta.error ? { isError: true } : {}) }],
        meta: { ...createDefaultAgentResult().meta, ...meta },
      };
      vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
        if (fault === "callback") {
          await params.onAgentEvent?.({
            stream: "lifecycle",
            data: {
              phase: "finishing",
              error: `Deferred provider failure. Authorization: Bearer ${secret}`,
            },
          });
        }
        return rawResult;
      });
      const actualDelivery = await vi.importActual<typeof import("../agents/command/delivery.js")>(
        "../agents/command/delivery.js",
      );
      vi.mocked(deliverAgentCommandResult).mockImplementationOnce(async (params) => {
        const projected = await actualDelivery.deliverAgentCommandResult(params);
        if (fault === "abort") {
          controller.abort();
        }
        return projected;
      });

      const result = await runCommand({
        message: "probe",
        agentId: "main",
        json: true,
        abortSignal: controller.signal,
      });

      expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(attemptExecutionRuntime.persistCliTurnTranscript)).not.toHaveBeenCalled();
      expect(result?.payloads).toEqual([
        { text, mediaUrl: null, ...(meta.error ? { isError: true } : {}) },
      ]);
      expect(vi.mocked(runtime.log).mock.calls.at(-1)?.[0]).toBe(JSON.stringify(result, null, 2));
      if (outcome === "completed" && !meta.yielded) {
        expect(result?.meta.terminalReply).toEqual({ disposition: "visible", text });
      }
      expect(readAgentRunTerminalOutcome(rawResult)).toBeUndefined();
      expect(readAgentRunTerminalError(rawResult)).toBeUndefined();
      expect(readAgentRunTerminalOutcome(result)).toBe(outcome);
      if (fault === "callback") {
        expect(readAgentRunTerminalError(result)).toContain("Deferred provider failure.");
        expect(readAgentRunTerminalError(result)).not.toContain(secret);
      } else if (outcome === "completed") {
        expect(readAgentRunTerminalError(result)).toBeUndefined();
      }
    },
  );

  it("keeps best-effort delivery failure separate from the completed run outcome", async ({
    cfg: _cfg,
  }) => {
    await useRealDelivery();

    const result = await runCommand({
      message: "probe",
      agentId: "main",
      json: true,
      deliver: true,
      channel: "webchat",
      bestEffortDeliver: true,
    });

    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(result?.deliveryStatus).toMatchObject({ status: "failed", succeeded: false });
    expect(readAgentRunTerminalOutcome(result)).toBe("completed");
  });

  it.for(["rejection", "cancellation"] as const)(
    "settles deferred cleanup %s before handing off the reply",
    async (fault, { cfg: _cfg }) => {
      const controller = new AbortController();
      const failure = new Error("Deferred cleanup failed");
      vi.mocked(attemptExecutionRuntime.runAgentAttempt).mockImplementationOnce(async (params) => {
        params.deferredLifecycle?.adopt({
          beginRetryWait: () => undefined,
          complete: async () => {
            if (fault === "rejection") {
              throw failure;
            }
            controller.abort();
          },
          discard: () => {},
        });
        return createDefaultAgentResult();
      });

      const command = runCommand({
        message: "probe",
        agentId: "main",
        abortSignal: controller.signal,
      });
      if (fault === "rejection") {
        await expect(command).rejects.toBe(failure);
      } else {
        expect(readAgentRunTerminalOutcome(await command)).toBe("failed");
      }
      expect(runtime.log).toHaveBeenCalledWith("ok");
    },
  );

  it.for(["text", "nested", "json"])(
    "returns ingress %s replies without writing them to Gateway logs",
    async (mode, { cfg: _cfg }) => {
      const text = "synthetic private ingress reply";
      vi.mocked(runEmbeddedAgent).mockResolvedValueOnce({
        ...createDefaultAgentResult(),
        payloads: [{ text }],
      });
      await useRealDelivery();
      const ingressRuntime = { ...runtime, writeStdout: vi.fn(), writeJson: vi.fn() };

      const result = await agentCommandFromIngress(
        {
          message: "probe",
          agentId: "main",
          allowModelOverride: false,
          ...(mode === "nested" ? { lane: "nested" } : {}),
          ...(mode === "json" ? { json: true } : {}),
        },
        ingressRuntime,
      );

      expect(result?.payloads).toEqual([expect.objectContaining({ text })]);
      expect(JSON.stringify(vi.mocked(runtime.log).mock.calls)).not.toContain(text);
      expect(JSON.stringify(vi.mocked(runtime.error).mock.calls)).not.toContain(text);
      expect(ingressRuntime.writeStdout).not.toHaveBeenCalled();
      expect(ingressRuntime.writeJson).not.toHaveBeenCalled();
    },
  );

  it("owns skill watching for ingress runs with oneShotCliRun=true", async ({ cfg: _cfg }) => {
    await runIngress({ message: "inspect skills", agentId: "main", oneShotCliRun: true });

    expect(resolveReusableWorkspaceSkillSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ watch: false }),
    );
  });

  it.for(["agent:main:dashboard:parent"])(
    "seeds only the configured workspace when a project run is spawned by %s",
    async (spawnedBy, { home }) => {
      const project = path.join(home, "project");
      const workspace = path.join(home, "openclaw");
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, "AGENTS.md"), "# Project instructions\n");
      mockConfig(home, path.join(home, "sessions.json"));
      await useRealWorkspace();

      const prepared = await prepareAgentCommandExecution(
        {
          message: "inspect this project",
          agentId: "main",
          sessionId: "project-bootstrap",
          workspaceDir: project,
          cwd: project,
          spawnedBy,
        },
        runtime,
      );

      expect(prepared.workspaceDir).toBe(project);
      expect(fs.readdirSync(project)).toEqual(["AGENTS.md"]);
      expect(fs.readFileSync(path.join(project, "AGENTS.md"), "utf8")).toBe(
        "# Project instructions\n",
      );
      for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
        expect(fs.existsSync(path.join(workspace, name)), name).toBe(true);
      }
    },
  );

  it("does not scaffold an implicit ACP workspace when the command supplies cwd", async ({
    home,
    store,
  }) => {
    const repository = path.join(home, "repository");
    const configuredWorkspace = path.join(repository, ".openclaw", "workspace");
    fs.mkdirSync(repository, { recursive: true });
    git(repository, "init", "-b", "main");
    fs.writeFileSync(path.join(repository, "README.md"), "base\n");
    git(repository, "add", "README.md");
    mockConfig(
      home,
      store,
      { workspace: configuredWorkspace },
      {
        codex: { runtime: { type: "acp", acp: { agent: "codex" } } },
      },
    );
    await useRealWorkspace();

    const prepared = await prepareAgentCommandExecution(
      {
        message: "inspect this repo",
        agentId: "codex",
        sessionId: "explicit-cwd-acp",
        cwd: repository,
      },
      runtime,
    );
    expect(prepared.workspaceDir).toBe(configuredWorkspace);

    expect(fs.existsSync(configuredWorkspace)).toBe(true);
    expect(fs.existsSync(path.join(configuredWorkspace, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(configuredWorkspace, ".git"))).toBe(false);
    expect(() => git(repository, "add", "-A")).not.toThrow();
  });

  it("uses the recorded canonical workspace for a managed-worktree skill snapshot", async ({
    home,
    store,
  }) => {
    const sessionKey = "agent:main:dashboard:managed-worktree";
    const canonicalWorkspace = path.join(home, "project");
    fs.mkdirSync(canonicalWorkspace, { recursive: true });
    git(canonicalWorkspace, "init", "-b", "main");
    git(canonicalWorkspace, "config", "user.name", "OpenClaw Test");
    git(canonicalWorkspace, "config", "user.email", "openclaw-test@example.invalid");
    fs.writeFileSync(path.join(canonicalWorkspace, "README.md"), "base\n");
    git(canonicalWorkspace, "add", "README.md");
    git(canonicalWorkspace, "commit", "-m", "initial");
    mockConfig(home, store);
    const worktree = await managedWorktrees.create({
      repoRoot: canonicalWorkspace,
      baseRef: "HEAD",
      name: "managed",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    await seedSession(store, sessionKey, {
      sessionId: "managed-worktree-session",
      spawnedCwd: worktree.path,
      worktree: {
        id: worktree.id,
        branch: worktree.branch,
        repoRoot: worktree.repoRoot,
        canonicalWorkspaceDir: canonicalWorkspace,
      },
    });

    await runIngress({ message: "inspect this repo", sessionKey, workspaceDir: worktree.path });

    const skillRoots = vi.mocked(resolveReusableWorkspaceSkillSnapshot).mock.calls.at(-1)?.[0];
    expect(skillRoots?.workspaceDir).toBe(path.join(home, "openclaw"));
    expect(skillRoots?.executionWorkspaceDir).toBe(canonicalWorkspace);
  });

  it("renders a Claude bundle command template on Gateway ingress", async ({ home, cfg }) => {
    const pluginRoot = path.join(home, "openclaw", ".openclaw", "extensions", "test-bundle");
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, "commands"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".claude-plugin/plugin.json"), '{"name":"test-bundle"}');
    fs.writeFileSync(
      path.join(pluginRoot, "commands", "workflows-review.md"),
      "---\nname: workflows-review\ndescription: Review a workflow\n---\nReview this workflow carefully.\n\nFocus on:\n$ARGUMENTS\n",
    );
    cfg.plugins = { entries: { "test-bundle": { enabled: true } } };
    clearPluginMetadataLifecycleCaches();

    await runIngress({ message: "/workflows_review retries and cleanup", agentId: "main" });

    expect(getLastEmbeddedCall()?.prompt).toBe(
      "Review this workflow carefully.\n\nFocus on:\nretries and cleanup",
    );
  });

  it("rejects an explicitly referenced skill hidden by the agent allowlist", async ({
    home,
    cfg,
  }) => {
    cfg.agents!.defaults!.skills = ["allowed-skill"];
    vi.mocked(resolveEffectiveAgentSkillFilter).mockReturnValueOnce(["allowed-skill"]);
    mockUserInvocableSkills(home, ["hidden-skill"]);

    await expect(runIngress({ message: "$hidden_skill", agentId: "main" })).rejects.toThrow(
      'Skill "hidden-skill" is not available for this agent. Update the skill allowlist or choose an allowed skill.',
    );
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("expands an explicit reference when the skills prompt catalog is unavailable", async ({
    home,
    cfg,
  }) => {
    cfg.skills = { limits: { maxSkillsPromptChars: 1 } };
    mockUserInvocableSkills(home, ["release-notes"]);

    await runIngress({ message: "Use $release_notes despite the catalog cap.", agentId: "main" });

    expect(getLastEmbeddedCall()?.skillsSnapshot?.prompt).toBe("");
    expect(getLastEmbeddedCall()?.prompt).toContain("- release-notes");
  });

  it("enforces ingress model override authorization", async () => {
    await expect(
      // Runtime guard for non-TS callers; TS callsites are statically typed.
      agentCommandFromIngress(
        {
          message: "hi",
          to: "+1555",
        } as never,
        runtime,
      ),
    ).rejects.toThrow("allowModelOverride must be explicitly set for ingress agent runs.");
  });

  it("strips private execution identity from runtime-shaped public ingress", async ({
    store,
    cfg: _cfg,
  }) => {
    const prepare = vi.spyOn(executionIdentity, "prepare");
    const inheritedAdmission = {
      token: {
        tokenVersion: 1 as const,
        contextId: "inherited-context",
        executionId: "inherited-execution",
        runId: "public-ingress-run",
        createdAt: 1,
      },
      retryOnly: true,
    };
    const priorDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "executionIdentityAdmission",
    );
    // oxlint-disable-next-line no-extend-native -- Simulate a hostile JS plugin's prototype pollution.
    Object.defineProperty(Object.prototype, "executionIdentityAdmission", {
      configurable: true,
      value: inheritedAdmission,
    });

    try {
      await agentCommandFromIngress(
        {
          message: "public plugin turn",
          agentId: "main",
          runId: "public-ingress-run",
          allowModelOverride: false,
          senderIsOwner: true,
          executionIdentityAdmission: {
            token: {
              tokenVersion: 1,
              contextId: "forged-context",
              executionId: "forged-execution",
              runId: "public-ingress-run",
              createdAt: 1,
            },
            retryOnly: true,
          },
        } as never,
        runtime,
      );

      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({ admission: undefined, runId: "public-ingress-run" }),
      );
      expect(
        vi.mocked(attemptExecutionRuntime.runAgentAttempt).mock.calls.at(-1)?.[0].opts,
      ).toMatchObject({ senderIsOwner: false });
    } finally {
      prepare.mockRestore();
      if (priorDescriptor) {
        // oxlint-disable-next-line no-extend-native -- Restore the exact pre-test prototype descriptor.
        Object.defineProperty(Object.prototype, "executionIdentityAdmission", priorDescriptor);
      } else {
        delete (Object.prototype as Record<string, unknown>).executionIdentityAdmission;
      }
    }
  });

  it("rejects a missing harness-owned session through embedded ingress", async ({ cfg: _cfg }) => {
    await expect(
      runIngress({
        message: "do not squat",
        sessionKey: "agent:main:harness:codex:supervision:missing-ingress",
      }),
    ).rejects.toThrow(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);

    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("enforces stored workspace permissions through public agent ingress", async ({
    home,
    store,
  }) => {
    const sessionKey = "agent:main:dashboard:workspace-permission";
    const sessionRoot = path.join(home, "worktree");
    const outsidePath = path.join(home, "outside.txt");
    const insidePath = path.join(sessionRoot, "inside.txt");
    fs.mkdirSync(sessionRoot, { recursive: true });
    mockConfig(home, store);
    await seedSession(store, sessionKey, {
      sessionId: "workspace-permission-session",
      spawnedCwd: sessionRoot,
      permissionMode: "workspace",
      sessionRoot,
    });
    attemptExecutionMocks.useRealRunAgentAttempt = true;

    let outsideWriteError: unknown;
    vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (opts) => {
      const codingRoot = opts.cwd ?? opts.workspaceDir;
      const writeTool = createHostWorkspaceWriteTool(codingRoot, {
        containmentRoot: opts.sessionRoot ?? codingRoot,
        workspaceOnly: opts.permissionMode !== undefined && opts.permissionMode !== "full",
      });
      try {
        await writeTool.execute("outside-write", {
          path: outsidePath,
          content: "outside",
        });
      } catch (error) {
        outsideWriteError = error;
      }
      await writeTool.execute("inside-write", {
        path: insidePath,
        content: "inside",
      });
      return createDefaultAgentResult();
    });

    await runIngress({ message: "write inside the session worktree", sessionKey });

    expect(outsideWriteError).toBeInstanceOf(Error);
    expect(String(outsideWriteError)).toMatch(/(?:sandbox|workspace) root/i);
    expect(fs.existsSync(outsidePath)).toBe(false);
    expect(fs.readFileSync(insidePath, "utf8")).toBe("inside");
  });

  it("preserves a Discord voice transcript across one automatic reset", async ({ home, store }) => {
    const sessionKey = "agent:main:discord:channel:voice-1";
    const staleStartedAt = Date.now() - 2 * 24 * 60 * 60_000;
    const cfg = mockConfig(home, store);
    cfg.session = { ...cfg.session, reset: { mode: "daily" } };
    await seedSession(store, sessionKey, {
      sessionId: "stale-voice-session",
      updatedAt: staleStartedAt,
      sessionStartedAt: staleStartedAt,
    });

    const runVoiceTurn = async (message: string) =>
      await runIngress({
        message,
        sessionKey,
        agentId: "main",
        messageChannel: "discord",
        messageProvider: "discord-voice",
        deliver: false,
      });

    await runVoiceTurn("remember 42");
    const firstSessionId = getLastEmbeddedCall()?.sessionId;
    expect(firstSessionId).toBe("stale-voice-session");
    const firstPersisted = readSessionStore<SessionEntry>(store)[sessionKey];
    expect(firstPersisted?.sessionId).toBe(firstSessionId);
    expect(firstPersisted?.sessionStartedAt).toBeGreaterThan(staleStartedAt);

    await runVoiceTurn("what number?");
    expect(getLastEmbeddedCall()?.sessionId).toBe(firstSessionId);

    const persisted = readSessionStore<SessionEntry>(store)[sessionKey];
    expect(persisted?.sessionId).toBe(firstSessionId);
    expect(persisted?.sessionStartedAt).toBeGreaterThan(staleStartedAt);
  });

  it.for([false, true])(
    "observes archive state changed during preparation: archived=%s",
    async (archived, { home, store }) => {
      const sessionKey = "agent:main:subagent:archive-race";
      const sessionId = "archive-race-session-id";
      mockConfig(home, store);
      await seedSession(store, sessionKey, {
        sessionId,
        ...(!archived && { archivedAt: Date.now() }),
      });
      vi.mocked(ensureAgentWorkspace).mockImplementationOnce(async (params) => {
        await seedSession(store, sessionKey, {
          sessionId,
          ...(archived && { archivedAt: Date.now() }),
        });
        return { dir: params?.dir ?? "/tmp/openclaw-workspace" };
      });
      const command = runIngress({
        message: archived ? "blocked after preparation" : "run after restore",
        sessionId,
      });
      if (archived) {
        await expect(command).rejects.toThrow(
          `Session "${sessionKey}" is archived. Restore it before starting new work.`,
        );
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
      } else {
        await command;
        expect(runEmbeddedAgent).toHaveBeenCalled();
        expect(readSessionStore<SessionEntry>(store)[sessionKey]?.archivedAt).toBeUndefined();
      }
    },
  );

  it("excludes an initiating agent turn from its own lifecycle interruption", async ({
    home,
    store,
  }) => {
    const sessionKey = "agent:main:subagent:in-band-lifecycle";
    const sessionId = "in-band-lifecycle-session-id";
    mockConfig(home, store);
    await seedSession(store, sessionKey, { sessionId });
    vi.mocked(runEmbeddedAgent).mockImplementationOnce(async () => {
      await expect(
        interruptSessionControllerEffects({
          scope: store,
          identities: [sessionKey, sessionId],
          timeoutMs: 5,
        }),
      ).resolves.toBe(true);
      return createDefaultAgentResult();
    });

    await runIngress({ message: "run an in-band lifecycle command", sessionId });

    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });

  it.for(["generic", "explicit restart", "terminal Stop"] as const)(
    "preserves lifecycle interruption semantics: %s",
    async (interruption, { home, store }) => {
      const sessionKey = "agent:main:subagent:lifecycle-restart";
      const sessionId = "lifecycle-restart-session-id";
      mockConfig(home, store);
      await seedSession(store, sessionKey, { sessionId });
      let observedAbortReason: unknown;
      const entered = createDeferredCore();
      const cleanup = new AbortController();
      const reason =
        interruption === "terminal Stop"
          ? createAgentRunDirectAbortError()
          : interruption === "explicit restart"
            ? createAgentRunRestartAbortError()
            : undefined;
      vi.mocked(runEmbeddedAgent).mockImplementationOnce(
        async (opts) =>
          await new Promise((resolve) => {
            entered.resolve();
            const finish = () => {
              observedAbortReason = opts.abortSignal?.reason;
              resolve(createDefaultAgentResult());
            };
            if (opts.abortSignal?.aborted) {
              finish();
              return;
            }
            opts.abortSignal?.addEventListener("abort", finish, { once: true });
          }),
      );

      const command = runIngress({
        message: "interrupt this lifecycle run",
        sessionId,
        abortSignal: cleanup.signal,
      }).catch((error: unknown) => error);
      try {
        await Promise.race([
          entered.promise,
          command.then((result) => {
            throw new Error("Command settled before embedded entry", { cause: result });
          }),
        ]);
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        await interruptSessionControllerEffects({
          scope: store,
          identities: [sessionKey, sessionId],
          reason,
        });
        const commandResult = await command;
        if (reason) {
          expect(observedAbortReason).toBe(reason);
        }
        expect(isAgentRunDirectAbortReason(observedAbortReason)).toBe(
          interruption === "terminal Stop",
        );
        expect(isAgentRunRestartAbortReason(observedAbortReason)).toBe(
          interruption === "explicit restart",
        );
        expect(isAgentRunRestartAbortReason(commandResult)).toBe(
          interruption === "explicit restart",
        );
      } finally {
        cleanup.abort(createAgentRunDirectAbortError());
        await command;
      }
    },
  );

  it("rejects a stale requested session id after command preparation", async ({ home, store }) => {
    const sessionKey = "agent:main:subagent:stale-request";
    mockConfig(home, store);
    await seedSession(store, sessionKey, { sessionId: "current-session-id" });

    await expect(
      runIngress({
        message: "do not enter the replacement session",
        sessionKey,
        sessionId: "stale-session-id",
      }),
    ).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("persists local overrides", async ({ store, cfg: _cfg }) => {
    vi.mocked(runEmbeddedAgent).mockResolvedValue(
      createDefaultAgentResult({
        payloads: [{ text: "json-reply", mediaUrl: "http://x.test/a.jpg" }],
        durationMs: 42,
      }),
    );

    await runCommand({
      message: "ping",
      to: "+1222",
      accountId: "kev",
      thinking: "high",
      verbose: "on",
      json: true,
    });

    const saved = readSessionStore<SessionEntry>(store);
    const entry = expectDefined(Object.values(saved)[0], "Object.values(saved)[0] test invariant");
    expect(entry).toMatchObject({ thinkingLevel: "high", verboseLevel: "on" });
    expect(getLastEmbeddedCall()).toMatchObject({
      thinkLevel: "high",
      verboseLevel: "on",
      prompt: "ping",
      agentAccountId: "kev",
    });

    const parsed: unknown = JSON.parse(String(vi.mocked(runtime.log).mock.calls.at(-1)?.[0]));
    expect(parsed).toMatchObject({
      payloads: [{ text: "json-reply", mediaUrl: "http://x.test/a.jpg" }],
      meta: { durationMs: 42 },
    });
  });

  registerAgentThinkingTests({ withTempHome, mockConfig, getLastEmbeddedCall, runtime });

  it("bypasses ACP sessions for one-shot model runs", async ({ home, store }) => {
    const sessionKey = "agent:main:main";
    mockConfig(home, store, { models: {} });
    await seedSession(store, sessionKey, { sessionId: "acp-backed-session" });
    const runTurn = vi.fn();
    acpManagerTesting.setAcpSessionManagerForTests({
      resolveSessionAsync: vi.fn(async () => ({
        kind: "ready",
        sessionKey,
        meta: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "runtime-1",
          mode: "persistent",
          state: "idle",
          lastActivityAt: Date.now(),
        },
      })),
      runTurn,
    });

    await runCommand({
      message: "Reply with exactly OPENCLAW-MODEL-OK",
      sessionKey,
      model: "openrouter/auto",
      modelRun: true,
      promptMode: "none",
    });

    expect(runTurn).not.toHaveBeenCalled();
    expect(getLastEmbeddedCall()).toMatchObject({
      provider: "openrouter",
      model: "openrouter/auto",
      prompt: "Reply with exactly OPENCLAW-MODEL-OK",
      modelRun: true,
      promptMode: "none",
      disableTools: true,
    });
  });

  registerAgentReplyPolicyTests({ withTempHome, mockConfig, runtime });
  registerAgentStoredOverrideTests({
    withTempHome,
    mockConfig,
    mockModelCatalogOnce,
    expectLastRunProviderModel,
    expectModelAttempts,
    runtime,
  });

  it("does not duplicate agent events from embedded runs", async ({ cfg: _cfg }) => {
    const assistantEvents: Array<{ runId: string; text?: string }> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.stream !== "assistant") {
        return;
      }
      assistantEvents.push({
        runId: evt.runId,
        text: typeof evt.data?.text === "string" ? evt.data.text : undefined,
      });
    });

    vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
      const runId = params.runId ?? "run";
      const data = { text: "hello", delta: "hello" };
      await params.onAgentEvent?.({ stream: "assistant", data });
      emitAgentEvent({ runId, stream: "assistant", data });
      return {
        payloads: [{ text: "hello" }],
        meta: { agentMeta: { provider: "p", model: "m" } },
      } as never;
    });

    await runCommand({ to: "+1555", thinking: "low" });
    stop();

    const matching = assistantEvents.filter((evt) => evt.text === "hello");
    expect(matching).toHaveLength(1);
  });

  it("handles one-off provider/model overrides and validates override values", async ({
    home,
    store,
  }) => {
    mockConfig(home, store, {
      models: {
        "anthropic/claude-opus-4-6": {},
        "openai/gpt-4.1-mini": {},
      },
    });

    await runCommand({
      message: "use the override",
      sessionKey: "agent:main:subagent:run-override",
      provider: "openai",
      model: "gpt-4.1-mini",
    });

    expectLastRunProviderModel("openai", "gpt-4.1-mini");

    const saved = readSessionStore<SessionEntry>(store);
    expect(saved["agent:main:subagent:run-override"]?.providerOverride).toBeUndefined();
    expect(saved["agent:main:subagent:run-override"]?.modelOverride).toBeUndefined();

    await seedSession(store, "agent:main:subagent:temp-openai-run", {
      sessionId: "session-temp-openai-run",
      authProfileOverride: "anthropic:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    vi.mocked(authProfileStoreModule.ensureAuthProfileStore).mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:work": {
          provider: "anthropic",
        },
      },
    } as never);

    await runCommand({
      message: "use a different provider once",
      sessionKey: "agent:main:subagent:temp-openai-run",
      provider: "openai",
      model: "gpt-4.1-mini",
    });

    expectLastRunProviderModel("openai", "gpt-4.1-mini");
    expect(getLastEmbeddedCall()?.authProfileId).toBeUndefined();

    const savedAuth = readSessionStore<SessionEntry>(store);
    expect(savedAuth["agent:main:subagent:temp-openai-run"]).toMatchObject({
      authProfileOverride: "anthropic:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });

    await expect(
      runCommand({
        message: "use an invalid override",
        sessionKey: "agent:main:subagent:invalid-override",
        provider: "openai\u001b[31m",
        model: "gpt-4.1-mini",
      }),
    ).rejects.toThrow("Provider override contains invalid control characters.");

    const parseModelRefSpy = vi.spyOn(modelSelectionModule, "parseModelRef");
    parseModelRefSpy.mockImplementationOnce(() => ({
      provider: "anthropic\u001b[31m",
      model: "claude-haiku-4-5\u001b[32m",
    }));
    mockConfig(home, store, {
      model: {
        primary: "openai/gpt-4.1-mini",
        fallbacks: ["anthropic/claude-haiku-4-5"],
      },
      models: {
        "openai/gpt-4.1-mini": {},
      },
      modelPolicy: { allow: ["openai/gpt-4.1-mini"] },
    });
    try {
      await expect(
        runCommand({
          message: "use disallowed override",
          sessionKey: "agent:main:subagent:sanitized-override-error",
          model: "claude-haiku-4-5",
        }),
      ).rejects.toThrow(
        'Model override "anthropic/claude-haiku-4-5" is not allowed for agent "main" by agents.defaults.modelPolicy.allow. Add "anthropic/claude-haiku-4-5" or "anthropic/*" to agents.defaults.modelPolicy.allow, or remove/empty the list to allow any model.',
      );
    } finally {
      parseModelRefSpy.mockRestore();
    }

    const legacyCfg = mockConfig(home, store, {
      model: {
        primary: "openai/gpt-4.1-mini",
        fallbacks: ["external/sensitive"],
      },
      models: {
        "openai/gpt-4.1-mini": {},
      },
    });
    delete (legacyCfg as { meta?: unknown }).meta;
    await expect(
      runCommand({
        message: "use the configured fallback directly",
        sessionKey: "agent:main:subagent:legacy-fallback-override",
        model: "external/sensitive",
      }),
    ).rejects.toThrow(
      'Model override "external/sensitive" is not allowed for agent "main" by agents.defaults.models. Add "external/sensitive" or "external/*" to agents.defaults.modelPolicy.allow, or remove/empty the list to allow any model.',
    );
  });

  it("passes routing context to embedded runs", async ({ home, store }) => {
    mockConfig(home, store, undefined, { ops: {} });

    await runCommand({ agentId: "ops", replyChannel: "slack", thinking: "low" });
    expectSessionTarget(store, "agent:ops:main");
    expect(getLastEmbeddedCall()?.messageChannel).toBe("slack");
    expect(runtime.log).toHaveBeenCalledWith("ok");

    await runCommand({
      to: "+1555",
      channel: "whatsapp",
      thinking: "low",
      runContext: { messageChannel: "slack", accountId: "acct-2" },
    });
    expect(getLastEmbeddedCall()).toMatchObject({
      messageChannel: "slack",
      agentAccountId: "acct-2",
    });

    await expect(runCommand({ agentId: "ghost" })).rejects.toThrow('Unknown agent id "ghost"');
  });

  it("routes explicit agent recipients through channel session contracts", async ({
    home,
    store,
  }) => {
    const cfg = mockConfig(home, store, undefined, { ops: {} });

    installThinkingTestProviders([
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "whatsapp",
          outbound: createDirectOutboundTestAdapter({ channel: "whatsapp" }),
          messaging: {
            resolveOutboundSessionRoute: (params) => {
              const chatType = params.target.endsWith("@g.us") ? "group" : "direct";
              return createOutboundSessionRouteFixture({
                cfg: params.cfg,
                agentId: params.agentId,
                channel: "whatsapp",
                accountId: params.accountId,
                peer: { kind: chatType, id: params.target },
                chatType,
                from: params.target,
                to: params.target,
              });
            },
          },
        }),
      },
    ]);
    cfg.session = { ...cfg.session, dmScope: "per-account-channel-peer" };
    await runCommand({
      agentId: "ops",
      channel: "whatsapp",
      to: "+15551234567",
      accountId: "work",
      thinking: "low",
    });
    let callArgs = getLastEmbeddedCall();
    expect(callArgs?.sessionKey).toBe("agent:ops:whatsapp:work:direct:+15551234567");

    await runCommand({
      agentId: "ops",
      channel: "whatsapp",
      to: "120363040000000000@g.us",
      thinking: "low",
    });
    callArgs = getLastEmbeddedCall();
    expect(callArgs?.sessionKey).toBe("agent:ops:whatsapp:group:120363040000000000@g.us");

    cfg.session = { ...cfg.session, dmScope: "main", mainKey: "work" };
    await runCommand({ agentId: "ops", channel: "webchat", to: "+15551234567", thinking: "low" });
    callArgs = getLastEmbeddedCall();
    expect(callArgs?.sessionKey).toBe("agent:ops:work");
  });

  it.for(["explicit", "default"] as const)(
    "routes and reuses keys for the %s agent",
    async (mode, { home, store }) => {
      await useRealCommandSessionPersistence();
      vi.mocked(runEmbeddedAgent).mockImplementation(async ({ sessionId }) =>
        createDefaultAgentResult({ sessionId }),
      );

      const explicit = mode === "explicit";
      mockConfig(
        home,
        store,
        explicit
          ? undefined
          : { systemAgent: { agentId: "ops" }, sessionStore: { agentId: "ops" } },
        { main: {}, ops: {} },
      );
      const agent = explicit ? { agentId: "ops" } : {};
      if (explicit) {
        await runCommand({ sessionKey: "agent:ops:incident-42" });
        expectSessionTarget(store, "agent:ops:incident-42");
      }
      await runCommand({ ...agent, sessionKey: "incident-42" });
      expect(getLastEmbeddedCall()).toMatchObject({
        agentId: "ops",
        sessionKey: "agent:ops:incident-42",
      });
      for (const sessionKey of ["global", "unknown"]) {
        await runCommand({ ...agent, sessionKey });
        const sessionId = expectSessionTarget(store, sessionKey);
        expectOpsSession(store, sessionKey, sessionId);
        await runCommand({ message: "again", ...(explicit ? { sessionId } : { sessionKey }) });
        if (explicit) {
          expect(getLastEmbeddedCall()).toMatchObject({ agentId: "ops", sessionKey, sessionId });
        } else {
          expect(getLastEmbeddedCall()?.sessionId).toBe(sessionId);
        }
        expectOpsSession(store, sessionKey, sessionId);
      }
    },
  );

  it("rejects agent-scoped to session selectors that conflict with the requested agent", async ({
    home,
    store,
  }) => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    await seedSession(store, sessionKey, { sessionId: "wechat-session" });
    mockConfig(home, store, undefined, { main: {}, work: {} });

    await expect(runCommand({ agentId: "work", to: sessionKey })).rejects.toThrow(
      'Agent id "work" does not match session key agent "main".',
    );
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("does not forward agent-scoped to session selectors as delivery targets", async ({
    home,
    store,
  }) => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    await seedSession(store, sessionKey, {
      sessionId: "wechat-session",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "+1555" },
      }),
    });
    mockConfig(home, store);
    installThinkingTestProviders([
      {
        pluginId: "telegram",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
        }),
      },
    ]);
    await runCommand({ to: sessionKey, deliver: true, channel: "telegram" });

    const deliveryCall = vi.mocked(deliverAgentCommandResult).mock.calls.at(-1)?.[0] as
      | { opts?: { to?: string }; sessionEntry?: Pick<SessionEntry, "delivery"> }
      | undefined;
    expect(deliveryCall?.opts?.to).toBeUndefined();
    expect(deliveryContextFromSession(deliveryCall?.sessionEntry)?.to).toBe("+1555");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
