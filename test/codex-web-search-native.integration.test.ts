import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { loadCodexNativeWebSearchTestFixture } from "../extensions/codex/test-api.js";
import {
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "../src/agents/agent-bundle-mcp-manager-api.js";
import { preparePluginHarnessParams } from "../src/agents/harness/plugin-attempt-params.js";
import {
  createSubagentSessionStore,
  withPreparedSessionCapabilityRead,
  type SessionCapabilitySnapshot,
} from "../src/agents/subagents/spawn/subagent-session-store.js";
import * as webSearchPolicy from "../src/agents/web-search-tool-policy.js";
import { upsertSessionEntryCore } from "../src/config/sessions/session-accessor.entry.js";
import { replaceSessionEntrySync } from "../src/config/sessions/session-accessor.sqlite-entry.js";
import { createDirectChatContext } from "../src/gateway/server-chat.agent-events.test-helpers.js";
import { SessionRowProjectionBinding } from "../src/gateway/session-row-projection-binding.js";
import { createSessionRowCapabilityReader } from "../src/gateway/session-row-projection-identities.js";
import { getTrackedWorkerPoolSnapshot } from "../src/infra/worker-cpu.js";
import { withPluginRuntimeGatewayContextResolver } from "../src/plugins/runtime/gateway-request-scope.js";
import { beginAgentDeletionJournal } from "../src/test-utils/agent-deletion-journal.js";
import { createTestGatewayScheduler } from "../src/test-utils/gateway-scheduler-clock.js";
import type { CodexAttemptRuntime } from "./types/vitest-codex-attempt-runtime.js";

const fixture = await loadCodexNativeWebSearchTestFixture();

beforeEach((context) => {
  let scheduler: ReturnType<typeof createTestGatewayScheduler> | undefined;
  const runtime: CodexAttemptRuntime = {
    readWorkerPools: getTrackedWorkerPoolSnapshot,
    async start() {
      scheduler = createTestGatewayScheduler();
      await setSessionMcpRuntimeScheduler(scheduler);
    },
    async stop() {
      scheduler?.beginClose();
      try {
        await disposeAllSessionMcpRuntimes();
      } finally {
        await scheduler?.stop();
      }
    },
  };
  context.codexAttemptRuntime = runtime;
});
fixture.setupRunAttemptTestHooks();

it.each([
  "unchanged",
  "changed",
  "requester-revoked",
  "requester-reassigned",
  "early-requester-revoked",
  "missing-requester-id-created",
  "late-requester-id-created",
  "late-requester-id-removed",
  "late-requester-id-reassigned",
] as const)(
  "binds prepared hosted search to current native authority for %s",
  async (transition) => {
    const params = fixture.createParams(
      path.join(fixture.tempDir, "session.jsonl"),
      fixture.tempDir,
      {
        sessionKey: `agent:main:dashboard:native-search-${transition}`,
        sessionId: `native-search-${transition}`,
        provider: "openai",
        prompt: "Synthetic native search policy proof.",
      },
    );
    params.config = {
      tools: {
        web: { search: { enabled: true } },
        byProvider: { "openai/search-denied": { deny: ["web_search"] } },
      },
    };
    fixture.setCodexTestModelSupportsTools(params, true);
    fixture.setCodexTestToolFactory(params, () => []);
    params.agentDir = path.join(fixture.tempDir, "agent");
    const codexHome = path.join(fixture.tempDir, "native-codex-home");
    vi.stubEnv("CODEX_HOME", codexHome);
    const scope = {
      agentId: "main",
      sessionKey: params.sessionKey!,
      storePath: resolveStorePath(undefined, { agentId: "main" }),
    };
    await upsertSessionEntryCore(scope, { sessionId: params.sessionId, updatedAt: 1 });
    const close = await fixture.bindProductionHarnessHostCapabilitiesForTest(params);
    try {
      const pluginConfig = {
        appServer: { mode: "guardian" as const, command: process.execPath, args: ["app-server"] },
        supervision: { enabled: true },
      };
      const harness = fixture.createCodexAppServerAgentHarness({
        bindingStore: fixture.testCodexAppServerBindingStore,
        pluginConfig,
      });
      const revokeRequester = () =>
        patchSessionEntry({
          ...scope,
          update: () => ({
            spawnedBy:
              transition === "requester-reassigned"
                ? "agent:main:other-parent"
                : "agent:main:parent",
            spawnDepth: 1,
            inheritedToolPolicyVersion: 1,
            inheritedToolAllow: [],
            inheritedToolDeny: transition === "requester-reassigned" ? [] : ["web_search"],
          }),
        });
      const binding = {
        threadId: "thread-native-search",
        cwd: fixture.tempDir,
        historyCoveredThrough: "2026-01-01T00:00:00.000Z",
        connectionScope: "supervision" as const,
        supervisionSourceThreadId: "thread-native-search",
        model: "search-allowed",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        rolloutPath: path.join(codexHome, "sessions", "thread-native-search.jsonl"),
        dynamicToolsFingerprint: fixture.codexDynamicToolsFingerprint([]),
        webSearchThreadConfigFingerprint: fixture.fingerprintJsonObject(
          fixture.buildCodexNativeWebSearchThreadConfig(params.config),
        ),
        appServerRuntimeFingerprint:
          fixture.buildCodexSupervisionTestConnectionFingerprint(pluginConfig),
      } satisfies Parameters<typeof fixture.writeCodexAppServerBinding>[1];
      await fixture.writeNativeCatalogFixture(binding.rolloutPath, binding.threadId, []);
      await fixture.writeCodexAppServerBinding(params.sessionFile, binding);
      let preparationReply = false;
      let mutation: Promise<void> | undefined;
      // oxlint-disable-next-line typescript/unbound-method -- Calls preserve the intercepted Worker receiver.
      const emit = Worker.prototype.emit;
      const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
        this: Worker,
        event,
        ...args: unknown[]
      ) {
        const reply = args[0];
        const result = isRecord(reply) && isRecord(reply.value) ? reply.value.value : undefined;
        if (
          event === "message" &&
          transition === "changed" &&
          !preparationReply &&
          isRecord(reply) &&
          reply.status === "ok" &&
          isRecord(result) &&
          (result.kind === "session-entry-read" || result.kind === "session-exact-entries")
        ) {
          preparationReply = true;
          // Delay only delivery of a real worker result while the native owner changes models.
          mutation = (async () => {
            if (transition === "changed") {
              await fixture.writeCodexAppServerBinding(params.sessionFile, {
                ...binding,
                model: "search-denied",
              });
            }
            emit.call(this, event, ...args);
          })();
          return true;
        }
        return emit.call(this, event, ...args);
      });
      let prepared: typeof params;
      const prepare = () =>
        preparePluginHarnessParams(params, harness, false, () => {}, false, {
          provider: "openai",
          model: "search-allowed",
        });
      try {
        if (transition === "changed") {
          const readProjection = createSessionRowCapabilityReader({
            state: () => ({ disposed: false, topologyDirty: true }),
            lookup: () => undefined,
            matching: () => [],
          });
          const context = createDirectChatContext({
            sessionRowProjectionOwner: new SessionRowProjectionBinding({}, readProjection),
          });
          beginAgentDeletionJournal({
            agentId: "native-search-retiring",
            operationId: "native-search-preparation",
            agentDir: path.join(fixture.tempDir, "retiring-agent"),
            sessionsDir: path.join(fixture.tempDir, "retiring-sessions"),
            workspaceDir: path.join(fixture.tempDir, "retiring-workspace"),
            deleteFiles: false,
            phase: "draining",
          });
          prepared = await withPluginRuntimeGatewayContextResolver(() => context, prepare);
        } else {
          prepared = await prepare();
        }
        await mutation;
      } finally {
        messages.mockRestore();
      }
      if (transition === "changed") {
        expect(preparationReply).toBe(true);
      }
      expect(prepared.preparedWebSearchPolicy).toMatchObject({
        allowed: true,
        persistentAllowed: true,
      });
      expect(prepared.pluginHarnessToolPolicyRestricted).toBe(false);
      if (transition === "early-requester-revoked") {
        await revokeRequester();
        params.hostCapabilities.assertActive();
        expect((await prepare()).preparedWebSearchPolicy).toMatchObject({ allowed: false });
      }
      const missingRequesterId = `native-search-requester-${transition}`;
      const requesterScope = { ...scope, sessionKey: "agent:main:dashboard:id-requester" };
      const lateIdChange = transition.startsWith("late-requester-id-");
      if (
        transition === "late-requester-id-removed" ||
        transition === "late-requester-id-reassigned"
      ) {
        await upsertSessionEntryCore(requesterScope, {
          sessionId: missingRequesterId,
          updatedAt: 1,
        });
      }
      if (transition === "missing-requester-id-created" || lateIdChange) {
        // Capture real ID-selector facts; the other cases prepare search policy through its normal path.
        const requesterFacts: SessionCapabilitySnapshot[] = [];
        const requester = await withPreparedSessionCapabilityRead(
          () =>
            createSubagentSessionStore(scope.storePath, scope.agentId).getById(missingRequesterId),
          { onRead: (snapshot) => requesterFacts.push(snapshot) },
        );
        if (
          transition === "missing-requester-id-created" ||
          transition === "late-requester-id-created"
        ) {
          expect(requester).toBeUndefined();
        } else {
          expect(requester).toMatchObject({ sessionId: missingRequesterId });
        }
        expect(requesterFacts).toContainEqual({
          query: {
            agentId: scope.agentId,
            storePath: scope.storePath,
            sessionId: missingRequesterId,
          },
          facts: requester === undefined ? undefined : expect.any(Array),
        });
        prepared = {
          ...prepared,
          preparedWebSearchPolicy: {
            ...prepared.preparedWebSearchPolicy!,
            requesterFacts: [
              ...(prepared.preparedWebSearchPolicy?.requesterFacts ?? []),
              ...requesterFacts,
            ],
          },
        };
      }
      const resolvePolicy = vi.spyOn(webSearchPolicy, "resolveWebSearchToolPolicy");
      const wire = await fixture.createLeasedCodexLifecycleHarness({
        agentDir: path.join(fixture.tempDir, "wire-agent"),
        codexHome,
        persistedThreads: [fixture.threadStartResult(binding.threadId, { cwd: fixture.tempDir })],
        respond(method) {
          if (method === "thread/resume") {
            return {
              ...fixture.threadStartResult(binding.threadId, { cwd: fixture.tempDir }),
              model: transition === "changed" ? "search-denied" : "search-allowed",
              modelProvider: "openai",
            };
          }
          if (method === "turn/start") {
            return fixture.turnStartResult();
          }
          if (method === "modelProvider/capabilities/read") {
            return { imageGeneration: false, webSearch: true };
          }
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "skills/list" || method === "thread/backgroundTerminals/list") {
            return { data: [], nextCursor: null };
          }
          return {};
        },
      });
      vi.spyOn(fixture.CodexAppServerClient, "start").mockResolvedValue(wire.client);
      fixture.setCodexAppServerClientFactoryForTest(async (_start, _auth, _dir, _config, options) =>
        fixture.getLeasedSharedCodexAppServerClient({
          ...options,
          ...wire.acquireOptions,
          preparedAuth: undefined,
          authRequirement: undefined,
        }),
      );
      let requesterChanged = false;
      if (
        transition === "requester-revoked" ||
        transition === "requester-reassigned" ||
        transition === "missing-requester-id-created" ||
        lateIdChange
      ) {
        const dispatch = fixture.CodexAppServerClient.prototype.request.bind(wire.client);
        wire.request.mockImplementation((method, body, options) =>
          method !== "thread/resume"
            ? dispatch(method, body, options)
            : dispatch(method, body, {
                ...options,
                withCurrent: async (write) => {
                  if (lateIdChange) {
                    expect(options?.withCurrent).toBeTypeOf("function");
                    await options!.withCurrent!(() => {
                      // All async rechecks/admission have finished; the physical write still checks its source.
                      replaceSessionEntrySync(
                        transition === "late-requester-id-reassigned"
                          ? { ...scope, sessionKey: "agent:main:dashboard:earlier-requester" }
                          : requesterScope,
                        {
                          sessionId:
                            transition === "late-requester-id-removed"
                              ? "replacement-requester"
                              : missingRequesterId,
                          updatedAt: 2,
                        },
                      );
                      requesterChanged = true;
                      write();
                    });
                    return;
                  }
                  if (!requesterChanged) {
                    if (transition === "missing-requester-id-created") {
                      await upsertSessionEntryCore(
                        {
                          ...scope,
                          sessionKey: "agent:main:dashboard:new-requester",
                        },
                        {
                          sessionId: missingRequesterId,
                          updatedAt: 2,
                          spawnedBy: "agent:main:parent",
                          spawnDepth: 1,
                          inheritedToolPolicyVersion: 1,
                          inheritedToolDeny: ["web_search"],
                        },
                      );
                    } else {
                      await revokeRequester();
                    }
                    requesterChanged = true;
                    params.hostCapabilities.assertActive();
                  }
                  if (options?.withCurrent) {
                    await options.withCurrent(write);
                  } else {
                    write();
                  }
                },
              }),
        );
      }
      const run = fixture.runCodexAppServerAttempt(prepared, { pluginConfig });
      const complete = run.waitForTurnAccepted().then(
        () =>
          wire.notify({
            method: "turn/completed",
            params: {
              threadId: binding.threadId,
              turn: { id: "turn-1", status: "completed", items: [] },
            },
          }),
        () => {},
      );
      const outcome = await run.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await complete;
      const requests = wire.writes.map(
        (line) => JSON.parse(line) as { method: string; params?: unknown },
      );
      const nativeWrites = requests.filter(
        ({ method }) =>
          method === "thread/resume" || method === "thread/start" || method === "turn/start",
      );
      const nativeSearch = nativeWrites
        .filter(({ method }) => method !== "turn/start")
        .map(({ params: requestParams }) =>
          isRecord(requestParams) && isRecord(requestParams.config)
            ? requestParams.config.web_search
            : undefined,
        );
      console.log(
        `[native-search] transition=${transition} thread-or-turn-writes=${nativeWrites.length} thread-search=${JSON.stringify(nativeSearch)} outcome=${"error" in outcome ? "rejected" : "completed"}`,
      );
      if (transition !== "unchanged") {
        expect(outcome).toHaveProperty("error");
        expect("error" in outcome && outcome.error).toMatchObject({
          message: expect.stringMatching(
            transition === "changed"
              ? /Native model changed after web search policy preparation/
              : /policy changed|superseded|no longer active/,
          ),
        });
        expect(nativeWrites).toEqual([]);
        if (
          transition === "requester-revoked" ||
          transition === "requester-reassigned" ||
          transition === "missing-requester-id-created" ||
          lateIdChange
        ) {
          expect(requesterChanged).toBe(true);
        }
      } else {
        expect(outcome).not.toHaveProperty("error");
        expect(nativeWrites.find(({ method }) => method === "thread/resume")?.params).toMatchObject(
          { config: { web_search: "cached" } },
        );
        expect(nativeWrites.filter(({ method }) => method === "turn/start")).toHaveLength(1);
        expect(resolvePolicy).not.toHaveBeenCalled();
      }
    } finally {
      close();
    }
  },
);
