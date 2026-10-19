/**
 * Dedicated E2E tier, outside default unit CI. Select this file explicitly:
 * pnpm test src/gateway/x-publication-owner-composition.e2e.test.ts --maxWorkers=1
 *
 * Real X client/parser/verifier/monitor -> registered host ingress/context ->
 * reply dispatch/run admission -> policy/visible spawn -> sessions.create/SQLite
 * -> anonymous HTTP reader. X HTTPS and the model runtime are deterministic.
 * No publication intent, public grant, session row, or read result is injected.
 * This is in-process source-composition evidence, not live deployment proof.
 */
import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { mergeAcceptedSessionSpawnsForRun } from "../agents/accepted-session-spawn.js";
import { createOpenClawCodingToolsAsync } from "../agents/agent-tools.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { readChildSessionPublication } from "../channels/message-access/child-session-publication.js";
import { importBundledChannelContractSourceArtifact } from "../channels/plugins/contracts/test-helpers/runtime-artifacts.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../config/config.js";
import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as channelOutbound from "../plugin-sdk/channel-outbound.js";
import * as ssrfRuntime from "../plugin-sdk/ssrf-runtime.js";
import { getPluginInstance, runPluginStreamConsumer } from "../plugins/plugin-instance-scope.js";
import {
  getPluginRecordRegistry,
  isPluginRecordActive,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createPluginServiceScheduler } from "../plugins/service-scheduler.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { prepareAgentWaitForTurn } from "./agent-turn/agent-wait.js";
import { isPublicSessionShareActive } from "./control-ui-public-session-read.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { AUTH_TOKEN, createTestGatewayServer, sendRequest } from "./server-http.test-harness.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import {
  gatewayReplyMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  setTestPluginRegistry,
} from "./test-helpers.js";

type Case =
  | "allowed"
  | "guest"
  | "delegation-revoked"
  | "revoked"
  | "author-revoked"
  | "owner-retired";
type AllowlistSnapshot = { allowFrom: string[]; assertCurrent: () => void };
type Post = {
  id: string;
  author_id: string;
  conversation_id: string;
  text: string;
  created_at: string;
  entities?: { mentions: Array<{ id: string; username: string }> };
};
type TransportCase = {
  root: Post;
  mention: Post;
  reads: Array<{ path: string; appOnly: boolean; ids: string[] }>;
  replies: string[];
};
let networkCase: TransportCase | undefined;
let rejectIngress: ((error: unknown) => void) | undefined;
const appToken = "synthetic-x-composition-app-token";
const userToken = "synthetic-x-composition-user-token";
const deniedWorkSessionReply =
  "[[x_failure]] Work session creation was denied; no public work session was created.";

// Fail closed: never delegate to fetch, credentials, or the network.
async function xResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const current = expectDefined(networkCase, "active synthetic X transport");
  const url = new URL(input instanceof Request ? input.url : input);
  expect(url.origin).toBe("https://api.x.com");
  console.info("[x-proof] X transport", init?.method, url.pathname);
  const headers = new Headers(init?.headers);
  if (url.pathname === "/2/oauth2/token") {
    expect(init?.method).toBe("POST");
    return Response.json({ access_token: userToken, expires_in: 7200 });
  }
  const appOnly = headers.get("authorization") === "Bearer " + appToken;
  expect(headers.get("authorization")).toBe("Bearer " + (appOnly ? appToken : userToken));
  const ids = url.searchParams.get("ids")?.split(",") ?? [];
  if (url.pathname === "/2/tweets" && init?.method === "POST") {
    if (typeof init.body !== "string") {
      throw new Error("X reply must use a JSON string body");
    }
    const body: unknown = JSON.parse(init.body);
    if (!isRecord(body) || typeof body.text !== "string") {
      throw new Error("Invalid synthetic X reply");
    }
    expect(body.reply).toEqual({ in_reply_to_tweet_id: current.mention.id });
    current.replies.push(body.text);
    return Response.json({ data: { id: "9999" } });
  }
  expect(init?.method).toBe("GET");
  current.reads.push({ path: url.pathname, appOnly, ids });
  const users = [
    { id: "10", username: "maintainer", protected: false },
    { id: "20", username: "guest", protected: false },
    { id: "100", username: "proofbot", protected: false },
  ];
  const page = (data: Post[]) => Response.json({ data, includes: { users }, meta: {} });
  if (url.pathname === "/2/users/100/mentions") {
    expect(appOnly).toBe(false);
    return page([current.mention]);
  }
  if (url.pathname === "/2/tweets/search/recent") {
    expect(appOnly).toBe(false);
    expect(url.searchParams.get("query")).toBe("conversation_id:" + current.root.id);
    return page([current.root, current.mention]);
  }
  if (url.pathname === "/2/tweets") {
    expect(ids.length).toBeGreaterThan(0);
    return page([current.root, current.mention].filter((candidate) => ids.includes(candidate.id)));
  }
  throw new Error("Unexpected X request: " + init?.method + " " + url.pathname);
}

// The Vitest project aliases SDK imports to these source modules. Mock the
// source boundary, not require.resolve's built package path (a distinct module).
vi.mock("../plugin-sdk/ssrf-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-sdk/ssrf-runtime.js")>()),
  fetchWithSsrFGuard: async (params: Parameters<typeof ssrfRuntime.fetchWithSsrFGuard>[0]) => ({
    response: await expectDefined(params.fetchImpl, "X guarded transport callback")(
      params.url,
      params.init,
    ),
    finalUrl: params.url,
    release: async () => {},
  }),
}));
// Observe the real delivery promise: retryable failures settle in the durable queue,
// not the monitor logger. Do not replace admission, delivery, or its result.
vi.mock("../plugin-sdk/channel-outbound.js", async (importOriginal) => {
  const original = await importOriginal<typeof channelOutbound>();
  const create: typeof original.createChannelIngressMonitor = (options) =>
    original.createChannelIngressMonitor({
      ...options,
      deliver: async (...args) => {
        try {
          return await options.deliver(...args);
        } catch (error) {
          console.error("[x-proof] ingress delivery failed", error);
          rejectIngress?.(error);
          throw error;
        }
      },
    });
  return { ...original, createChannelIngressMonitor: create };
});
vi.mock("../plugin-sdk/runtime-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-sdk/runtime-fetch.js")>()),
  fetchWithRuntimeDispatcher: xResponse,
}));
const { xPlugin } = await importBundledChannelContractSourceArtifact<{
  xPlugin: ChannelPlugin<unknown>;
}>("x", "channel-plugin-api.js", {});
const { setXRuntime } = await importBundledChannelContractSourceArtifact<{
  setXRuntime: (runtime: PluginRuntime) => void;
}>("x", "runtime-api.js", {});
const { openXAllowlist } = await importBundledChannelContractSourceArtifact<{
  openXAllowlist: (runtime: PluginRuntime) => {
    put: (
      accountId: string,
      entry: { userId: string; username: string; name: string; addedBy: string; addedAt: number },
    ) => Promise<void>;
    remove: (accountId: string, userId: string) => Promise<unknown>;
    readSnapshot: (accountId: string) => Promise<AllowlistSnapshot>;
  };
}>("x", "test-api.js", {});

function post(id: string, root: string, author: string, text: string): Post {
  return {
    id,
    author_id: author,
    conversation_id: root,
    text,
    created_at: "2026-10-01T12:00:00.000Z",
  };
}

function observedDeferred<T>() {
  const deferred = Promise.withResolvers<T>();
  // Observe immediately; awaiting the original promise still surfaces its rejection.
  void deferred.promise.catch(() => {});
  return deferred;
}

describe("X publication production-owner composition", () => {
  installGatewayTestHooks();

  it("renews stale X authority for public creation and rejects revocation before commit", async ({
    signal,
    onTestFailed,
  }) => {
    const channels: OpenClawConfig["channels"] = {
      x: {
        userId: "100",
        username: "proofbot",
        clientId: "synthetic-client",
        clientSecret: "synthetic-client-secret",
        refreshToken: "synthetic-refresh-token",
        bearerToken: appToken,
        allowFrom: [],
        groupPolicy: "allowlist",
        autoPublishWorkSessions: true,
        guests: { enabled: true },
        events: { mode: "poll", pollSeconds: 60 },
        replySignature: "",
      },
    };
    clearRuntimeConfigSnapshot();
    const baseConfig = await captureRuntimeConfigAsyncReader()();
    const config: OpenClawConfig = {
      ...baseConfig,
      agents: {
        defaults: {
          ...baseConfig.agents?.defaults,
          model: { primary: "x-proof/proof-model" },
        },
        entries: {
          main: {
            skills: [],
            tools: { fs: { workspaceOnly: true }, deny: ["exec", "write", "edit", "apply_patch"] },
            subagents: { allowAgents: ["coder"], delegateToolsTo: ["coder"] },
          },
          coder: { skills: [], tools: { fs: { workspaceOnly: true } } },
        },
      },
      channels,
      bindings: [{ agentId: "main", match: { channel: "x", accountId: "default" } }],
      messages: { queue: { mode: "collect" }, inbound: { debounceMs: 0 } },
      skills: { load: { watch: false } },
      gateway: { publicOrigin: "https://public-proof.example.test" },
      tools: {
        codeMode: false,
        exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: false },
      },
      models: {
        providers: {
          "x-proof": {
            api: "openai-completions",
            baseUrl: "https://model-proof.example.test/v1",
            apiKey: "synthetic-model-proof-key",
            models: [
              {
                id: "proof-model",
                name: "Composition model fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 2048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const cfg = () => getRuntimeConfig();
    expect(await xPlugin.config.inspectAccount?.(cfg(), "default")).toMatchObject({
      configured: true,
      enabled: true,
    });
    const sessionStore = resolveSessionStorePathCore(cfg().session?.store, { agentId: "main" });
    const childStore = resolveSessionStorePathCore(cfg().session?.store, { agentId: "coder" });
    const gateway = createDirectChatContext({
      getRuntimeConfig: cfg,
      loadGatewayModelCatalog: async () => [
        {
          id: "proof-model",
          name: "Composition model fixture",
          provider: "x-proof",
          input: ["text"],
          contextWindow: 32000,
        },
      ],
    });
    gateway.resolveGatewayContext = () => gateway;
    // Registry completion must observe the real child, not the direct fixture's empty wait result.
    vi.mocked(
      expectDefined(gateway.recoveryRuntime, "Gateway recovery fixture").waitForAgent,
    ).mockImplementation(
      async (params) => (await prepareAgentWaitForTurn(gateway, params).wait()).result,
    );
    gateway.readPreparedGatewayModelCatalog = async () => {
      const catalog = await gateway.loadGatewayModelCatalogSnapshot();
      return { entries: catalog.entries, routeVariants: catalog.routeVariants };
    };
    const runtime = createPluginRuntime();
    bindGatewayContextResolver(runtime.subagent, () => gateway);
    let rejectMonitor: ((error: Error) => void) | undefined;
    const reportMonitorFailure = (message: string) => {
      console.error("[x-proof] monitor failure", message);
      rejectMonitor?.(new Error(message));
    };
    const logger = {
      info() {},
      warn: reportMonitorFailure,
      error: reportMonitorFailure,
      debug() {},
    };
    const builder = createPluginRegistry({ logger, runtime, activateGlobalSideEffects: false });
    const record = createPluginRecord({ id: "x", origin: "bundled" });
    const api = builder.createApi(record, { config: cfg(), registrationMode: "full" });
    api.registerChannel({ plugin: xPlugin });
    builder.registry.plugins.push(record);
    markPluginRegistryActive(builder.registry);
    setTestPluginRegistry(builder.registry);
    const instance = expectDefined(getPluginInstance(record), "registered X instance");
    instance.run(() => setXRuntime(api.runtime));
    // Agent-core starts tools while consuming the provider's stream, inside that
    // provider plugin's invocation. Host tools must not borrow its runtime slots.
    const providerRecord = createPluginRecord({ id: "proof-provider", origin: "bundled" });
    builder.createApi(providerRecord, { config: cfg(), registrationMode: "full" });
    builder.registry.plugins.push(providerRecord);
    const providerInstance = expectDefined(
      getPluginInstance(providerRecord),
      "registered provider instance",
    );
    const allowlist = openXAllowlist(api.runtime);
    const allowlistEntry = (userId: string) => ({
      userId,
      username: userId === "10" ? "maintainer" : "unrelated",
      name: "Synthetic X author",
      addedBy: "composition-proof",
      addedAt: 0,
    });
    await allowlist.put("default", allowlistEntry("10"));
    const registeredX = expectDefined(
      builder.registry.channels.find((entry) => entry.pluginId === "x"),
      "registered X channel",
    );
    // Standard Gateway fixture defaults to a no-op reply; explicitly restore the owner.
    gatewayReplyMock.mockImplementation(getReplyFromConfig);
    console.info("[x-proof] preparing model runtime");
    await prepareGatewayReplyRuntimeForTest({ config: cfg() });
    console.info("[x-proof] model runtime prepared");

    let activeCase: Case = "allowed";
    let interruptedWait: Error | undefined;
    onTestFailed(() => {
      // Vitest records its timeout before the aborted test body finishes unwinding.
      if (interruptedWait) {
        throw interruptedWait;
      }
    });
    const waitFor = async <T>(description: string, work: PromiseLike<T>) => {
      try {
        return await withinTest(work, signal);
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
        // Cleanup uses the same signal; preserve the first interrupted await.
        interruptedWait ??= new Error(`X publication ${activeCase}: waiting for ${description}`, {
          cause: error,
        });
        throw interruptedWait;
      }
    };
    let creating = false;
    let creationSettled = Promise.withResolvers<void>();
    let revokedInCatalogWait = false;
    let delegationRevokedInCatalogWait = false;
    let authorRevokedInCatalogWait = false;
    let ownerRetiredInCatalogWait = false;
    const staleSnapshots = new Map<Case, AllowlistSnapshot>();
    const creationRequests: Array<{ kind: Case; parent: unknown }> = [];
    const catalog = gateway.loadGatewayModelCatalogSnapshot;
    gateway.loadGatewayModelCatalogSnapshot = async (request) => {
      const snapshot = await catalog(request);
      // Awaited creation dependency, after visible spawn captured its live
      // ingress capability and before the creation owner can commit any row.
      if (creating && activeCase === "revoked" && !revokedInCatalogWait) {
        revokedInCatalogWait = true;
        const next = structuredClone(cfg());
        next.channels!.x!.autoPublishWorkSessions = false;
        setRuntimeConfigSnapshot(next);
      }
      if (creating && activeCase === "delegation-revoked" && !delegationRevokedInCatalogWait) {
        delegationRevokedInCatalogWait = true;
        const next = structuredClone(cfg());
        next.agents!.entries!.main!.subagents!.delegateToolsTo = [];
        setRuntimeConfigSnapshot(next);
      }
      if (creating && activeCase === "author-revoked" && !authorRevokedInCatalogWait) {
        authorRevokedInCatalogWait = true;
        await allowlist.remove("default", "10");
        expect((await allowlist.readSnapshot("default")).allowFrom).not.toContain("10");
      }
      if (creating && activeCase === "owner-retired" && !ownerRetiredInCatalogWait) {
        ownerRetiredInCatalogWait = true;
        // The Gateway fixture adopts this record into its retained registry.
        // Retire that current owner, not the builder registry it no longer owns.
        const ownerRegistry = getPluginRecordRegistry(builder.registry, record);
        expect(isPluginRecordActive(ownerRegistry, record), activeCase).toBe(true);
        markPluginRegistryRetired(ownerRegistry);
        expect(isPluginRecordActive(builder.registry, record), activeCase).toBe(false);
      }
      return snapshot;
    };
    gateway.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry(
        [
          {
            name: "sessions.create",
            scope: "operator.write",
            owner: { kind: "core", area: "sessions" },
            handler: async (options: GatewayRequestHandlerOptions) => {
              console.info("[x-proof] real sessions.create entered", activeCase);
              creationRequests.push({ kind: activeCase, parent: options.params.parentSessionKey });
              creating = true;
              try {
                await expectDefined(
                  sessionCreateHandlers["sessions.create"],
                  "sessions.create owner",
                )(options);
              } finally {
                creating = false;
                creationSettled.resolve();
              }
            },
          },
        ],
        builder.registry,
      );

    const outcomes = new Map<Case, unknown>();
    const spawnErrors = new Map<Case, unknown>();
    const publications = new Map<Case, boolean>();
    const childWritten = observedDeferred<string>();
    const childRuns = new Set<Promise<unknown>>();
    const runModel = async (params: Parameters<typeof embeddedAgent.runEmbeddedAgent>[0]) => {
      const admitted =
        params.admittedRunContext ??
        (await expectDefined(params.preparedRunAdmission, "production reply-owned admission").admit(
          "embedded",
        ));
      const key = expectDefined(params.sessionKey, "admitted session key");
      console.info("[x-proof] model admitted", key);
      const child = key.includes(":dashboard:");
      const modelCaller = expectDefined(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: child ? "coder" : "main",
          sessionKey: key,
        }),
        "admitted model execution scope",
      );
      // The deterministic model replaces the runner, including its admitted caller
      // boundary. Child tools must not borrow the intake turn’s completed receipt.
      return withGatewayToolCallerIdentity(modelCaller, async () => {
        if (
          params.userTurnTranscriptRecorder &&
          !params.userTurnTranscriptRecorder.hasPersisted()
        ) {
          expect(await params.userTurnTranscriptRecorder.persistApproved()).toBeTruthy();
        }
        params.onExecutionPhase?.({ phase: "model_call_started" });
        let text = "[[x_success]] Synthetic X invocation settled.";
        if (!child) {
          const publication = readChildSessionPublication(admitted.operationalRunInstance);
          publications.set(activeCase, publication !== undefined);
          publication?.assertCurrent();
          const staleSnapshot = staleSnapshots.get(activeCase);
          if (staleSnapshot) {
            expect(() => staleSnapshot.assertCurrent()).toThrow("X allowlist changed");
            expect(publication).toBeDefined();
          }
          const caller = expectDefined(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: "main",
              sessionKey: key,
            }),
            "admitted model tool caller",
          );
          try {
            const result = await withGatewayToolCallerIdentity(caller, async () => {
              // Production assembly derives restrictions from the monitor context;
              // this fixture never manufactures inheritedToolPolicySource.
              const tools = await createOpenClawCodingToolsAsync({
                config: params.config,
                agentId: "main",
                sessionKey: key,
                runId: params.runId,
                sessionId: params.sessionId,
                operationalRunInstance: admitted.operationalRunInstance,
                workspaceDir: params.workspaceDir,
                messageProvider: params.messageProvider,
                agentAccountId: params.agentAccountId,
                senderId: params.senderId,
                senderIsOwner: params.senderIsOwner,
                groupId: params.groupId,
                conversationToolPolicy: params.conversationToolPolicy,
                toolConstructionPlan: {
                  includeBaseCodingTools: true,
                  includeShellTools: true,
                  includeChannelTools: false,
                  includeOpenClawTools: true,
                  includePluginTools: false,
                },
              });
              for (const name of ["exec", "write", "edit"]) {
                expect(
                  tools.some((tool) => tool.name === name),
                  name,
                ).toBe(false);
              }
              const spawn = expectDefined(
                tools.find((tool) => tool.name === "sessions_spawn"),
                "real sessions_spawn tool",
              );
              const providerStream = providerInstance.run(() => Promise.resolve({}));
              return runPluginStreamConsumer(providerStream, () =>
                spawn.execute("x-proof-" + activeCase, {
                  task: "Persist the synthetic publication composition answer.",
                  label: "X publication " + activeCase,
                  runtime: "subagent",
                  agentId: "coder",
                  visible: true,
                  context: "isolated",
                  expectsCompletionMessage: false,
                }),
              );
            });
            outcomes.set(activeCase, result.details);
            if (isRecord(result.details) && typeof result.details.error === "string") {
              text = deniedWorkSessionReply;
            }
            console.info("[x-proof] spawn result", activeCase, result.details);
          } catch (error) {
            spawnErrors.set(activeCase, error);
            outcomes.set(activeCase, { error: String(error) });
            text = deniedWorkSessionReply;
            console.info("[x-proof] spawn error", activeCase, String(error));
          }
        } else {
          const tools = await createOpenClawCodingToolsAsync({
            config: params.config,
            agentId: "coder",
            sessionKey: key,
            runId: params.runId,
            sessionId: params.sessionId,
            operationalRunInstance: admitted.operationalRunInstance,
            workspaceDir: params.workspaceDir,
            inputProvenance: params.inputProvenance,
            toolConstructionPlan: {
              includeBaseCodingTools: true,
              includeShellTools: true,
              includeChannelTools: false,
              includeOpenClawTools: false,
              includePluginTools: false,
            },
          });
          for (const name of ["exec", "write", "edit"]) {
            expect(
              tools.some((tool) => tool.name === name),
              name,
            ).toBe(true);
          }
          const writer = expectDefined(
            tools.find((tool) => tool.name === "write"),
            "child writer",
          );
          const proofPath = path.join(params.workspaceDir, "delegation-proof.txt");
          await writer.execute("delegated-write", {
            path: proofPath,
            content: "coding handoff works",
          });
          expect(await fs.readFile(proofPath, "utf8")).toBe("coding handoff works");
          const executor = expectDefined(
            tools.find((tool) => tool.name === "exec"),
            "child executor",
          );
          const executed = await executor.execute(
            "delegated-exec",
            {
              command: "echo coding-handoff-works",
              workdir: params.workspaceDir,
            },
            signal,
          );
          expect(executed.details).toMatchObject({ status: "completed", exitCode: 0 });
          expect(executed.content).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("coding-handoff-works"),
              }),
            ]),
          );
          text = "X publication composition: durable child answer.";
        }
        const appended = await appendTranscriptMessage(
          {
            agentId: child ? "coder" : "main",
            sessionKey: key,
            sessionId: params.sessionId,
            storePath: child ? childStore : sessionStore,
          },
          { message: { role: "assistant", content: text } },
        );
        expect(appended.appended).toBe(true);
        if (child) {
          childWritten.resolve(key);
        }
        return {
          payloads: [{ text }],
          meta: { durationMs: 0, stopReason: "stop" as const },
          acceptedSessionSpawns: mergeAcceptedSessionSpawnsForRun(admitted.operationalRunInstance),
        };
      });
    };
    const model = vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation((params) => {
      const work = runModel(params);
      if (params.sessionKey?.includes(":dashboard:")) {
        childRuns.add(work);
        void work.catch(childWritten.reject);
      }
      return work;
    });
    console.info("[x-proof] preparing projection");
    const projection = await createSessionRowProjection({ cfg: cfg(), modelCatalog: [] });
    console.info("[x-proof] projection prepared");
    bindSessionRowProjection(gateway, () => projection);
    const http = createTestGatewayServer({
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        getRuntimeConfig: cfg,
        getGatewayRequestContext: () => gateway,
        httpRequestLifetime: gateway,
      },
    });
    const channel = api.runtime.channel;
    const originalDispatch = channel.inbound.dispatch;
    let dispatched = observedDeferred<void>();
    // Pass-through observation only: no replacement result or ingress capability.
    channel.inbound.dispatch = async (...args) => {
      console.info("[x-proof] real dispatch entered", activeCase);
      try {
        if (
          activeCase === "allowed" ||
          activeCase === "author-revoked" ||
          activeCase === "owner-retired"
        ) {
          // The monitor has already captured publication intent and built its
          // host-bound context. Mutate real SQLite policy before run admission.
          const snapshot = await allowlist.readSnapshot("default");
          expect(snapshot.allowFrom).toContain("10");
          await allowlist.put("default", allowlistEntry("40"));
          expect(() => snapshot.assertCurrent()).toThrow("X allowlist changed");
          staleSnapshots.set(activeCase, snapshot);
        }
        const result = await originalDispatch(...args);
        dispatched.resolve();
        return result;
      } catch (error) {
        dispatched.reject(error);
        throw error;
      }
    };
    const rows = () => listSessionEntriesCore({ agentId: "coder", storePath: childStore });
    try {
      for (const [index, kind] of (
        [
          "allowed",
          "guest",
          "delegation-revoked",
          "revoked",
          "author-revoked",
          "owner-retired",
        ] as const
      ).entries()) {
        if (kind !== "allowed" && kind !== "guest") {
          await allowlist.put("default", allowlistEntry("10"));
          const restored = structuredClone(cfg());
          restored.agents!.entries!.main!.subagents!.delegateToolsTo = ["coder"];
          // The public grant deliberately retires on any config change. Use a
          // private handoff to prove delegation itself rejects the deferred commit.
          restored.channels!.x!.autoPublishWorkSessions = kind !== "delegation-revoked";
          setRuntimeConfigSnapshot(restored);
        }
        activeCase = kind;
        creationSettled = Promise.withResolvers<void>();
        dispatched = observedDeferred<void>();
        rejectMonitor = dispatched.reject;
        rejectIngress = dispatched.reject;
        const rootId = String(500 + index * 100);
        const mention = post(
          String(Number(rootId) + 1),
          rootId,
          kind === "guest" ? "20" : "10",
          "@proofbot start a public work session",
        );
        mention.entities = { mentions: [{ id: "100", username: "proofbot" }] };
        networkCase = {
          root: post(rootId, rootId, "10", "Public composition request"),
          mention,
          reads: [],
          replies: [],
        };
        const abort = new AbortController();
        const scheduling = createPluginServiceScheduler(createTestGatewayScheduler());
        const start = expectDefined(
          registeredX.plugin.gateway?.startAccount,
          "registered X monitor entry",
        );
        const monitor = Promise.resolve(
          start({
            cfg: cfg(),
            accountId: "default",
            account: xPlugin.config.resolveAccount(cfg(), "default"),
            channelRuntime: channel,
            scheduler: scheduling.scheduler,
            abortSignal: abort.signal,
            runtime: createRuntimeEnv(),
            log: logger,
            getStatus: () => ({ accountId: "default" }),
            setStatus() {},
          }),
        );
        try {
          const dispatch =
            kind === "owner-retired"
              ? dispatched.promise
              : awaitGateBeforeSettlement(
                  dispatched.promise,
                  monitor,
                  "X monitor ended before production reply dispatch",
                );
          await waitFor(
            "reply dispatch",
            dispatch.catch((error: unknown) => {
              if (!creationRequests.some((request) => request.kind === kind)) {
                throw error;
              }
              // Author removal forbids final delivery. Registry retirement may
              // instead reject the monitor's last plugin-runtime callback.
              if (kind === "author-revoked") {
                expect(authorRevokedInCatalogWait).toBe(true);
              } else if (kind === "owner-retired") {
                expect(ownerRetiredInCatalogWait).toBe(true);
              } else {
                throw error;
              }
            }),
          );
          if (kind !== "guest") {
            if (!creationRequests.some((request) => request.kind === kind)) {
              if (spawnErrors.has(kind)) {
                throw spawnErrors.get(kind);
              }
              throw new Error(
                `X ${kind} dispatch completed without sessions.create; outcome: ${JSON.stringify(outcomes.get(kind))}`,
              );
            }
            await waitFor("sessions.create settlement", creationSettled.promise);
          }
        } finally {
          rejectMonitor = undefined;
          rejectIngress = undefined;
          abort.abort();
          try {
            await waitFor(
              "monitor shutdown",
              monitor.catch((error: unknown) => {
                if (kind !== "owner-retired" || !ownerRetiredInCatalogWait) {
                  throw error;
                }
                // Retirement can reject the monitor's last plugin-runtime callback.
                expect(String(error)).toContain("reloaded or disabled");
              }),
            );
          } finally {
            await waitFor("scheduler shutdown", Promise.resolve(scheduling.close()));
          }
        }
        if (kind === "owner-retired") {
          expect(ownerRetiredInCatalogWait, kind).toBe(true);
          expect(
            creationRequests.filter((request) => request.kind === kind),
            kind,
          ).toHaveLength(1);
        }
        // Check the durable effect before delivery, so a reply failure cannot hide a grant.
        expect(rows(), kind).toHaveLength(1);
        expect(
          rows().filter(({ entry }) => resolveSessionPublicShare(entry)),
          kind,
        ).toHaveLength(1);
        expect(
          rows().filter(({ entry }) => entry.parentSessionKey === "agent:main:x:group:" + rootId),
          kind,
        ).toHaveLength(kind === "allowed" ? 1 : 0);
        // Only a declared success reaches X; denied work-session replies are withheld.
        const outcome = outcomes.get(kind);
        const succeeded =
          publications.has(kind) &&
          !spawnErrors.has(kind) &&
          !(isRecord(outcome) && typeof outcome.error === "string");
        if (!succeeded) {
          expect(networkCase.replies, kind).toEqual([]);
        } else if (kind !== "owner-retired") {
          // Retirement may still reject delivery of an admitted success.
          expect(networkCase.replies, kind).toHaveLength(1);
        }
        const publicReads = networkCase.reads.filter((request) => request.appOnly);
        if (kind === "guest") {
          expect(publicReads).toEqual([]);
          expect(publications.get(kind)).toBe(false);
          expect(outcomes.get(kind)).toMatchObject({
            status: "forbidden",
            error: expect.stringContaining("hidden helpers"),
          });
          expect(creationRequests.filter((request) => request.kind === kind)).toEqual([]);
        } else if (kind === "delegation-revoked") {
          expect(publicReads).toEqual([]);
          expect(publications.get(kind)).toBe(false);
          expect(creationRequests.filter((request) => request.kind === kind)).toHaveLength(1);
          expect(delegationRevokedInCatalogWait).toBe(true);
          expect(outcomes.get(kind)).toMatchObject({
            error: expect.stringContaining("authorization changed"),
          });
        } else {
          expect(publicReads).toEqual([
            { path: "/2/tweets", appOnly: true, ids: expect.arrayContaining([rootId, mention.id]) },
          ]);
          expect(publications.get(kind)).toBe(true);
          expect(creationRequests.filter((request) => request.kind === kind)).toHaveLength(1);
          if (kind === "allowed") {
            expect(outcomes.get(kind)).toMatchObject({ status: "accepted", publicRead: true });
            const key = await waitFor("child transcript write", childWritten.promise);
            const entry = expectDefined(
              loadSessionEntry({ agentId: "coder", sessionKey: key, storePath: childStore }),
              "committed child row",
            );
            const publication = expectDefined(
              resolveSessionPublicShare(entry),
              "committed child publication",
            );
            expect(publication.sessionId).toBe(entry.sessionId);
            // The append checkpoint precedes the run's final session metadata writes.
            const childReleased = captureSessionControllerSettlement({
              scope: childStore,
              identities: [key, entry.sessionId],
              agentId: "coder",
            });
            if (childReleased) {
              await waitFor("child admission release", childReleased);
            }
            await waitFor("projection membership", projection.prepareMembership());
            expect(
              isPublicSessionShareActive(
                cfg(),
                {
                  agentId: "coder",
                  sessionKey: key,
                  sessionId: publication.sessionId,
                  shareId: publication.id,
                },
                projection,
              ),
            ).toBe(true);
            const response = await waitFor(
              "anonymous public read",
              sendRequest(http, {
                path: new URL(
                  expectDefined(
                    resolveControlUiSessionUrl(cfg(), { sessionKey: key }),
                    "canonical child URL",
                  ),
                ).pathname,
                host: "localhost",
                remoteAddress: "127.0.0.1",
              }),
            );
            expect(response.res.statusCode, response.getBody()).toBe(200);
            expect(response.getBody()).toContain(
              "X publication composition: durable child answer.",
            );
            expect(response.getBody()).not.toContain("openclaw-app");
          } else if (kind === "revoked") {
            expect(revokedInCatalogWait).toBe(true);
            expect(outcomes.get(kind)).toMatchObject({
              error: expect.stringContaining("publication policy changed"),
            });
          } else if (kind === "author-revoked") {
            expect(staleSnapshots.has(kind)).toBe(true);
            expect(authorRevokedInCatalogWait).toBe(true);
            expect(outcomes.get(kind), kind).toMatchObject({
              error: expect.stringContaining("X allowlist changed"),
            });
          } else {
            expect(staleSnapshots.has(kind)).toBe(true);
            expect(ownerRetiredInCatalogWait).toBe(true);
            // The outer Gateway binding surfaces retirement before the inner publication error.
            expect(outcomes.get(kind), kind).toMatchObject({
              error: "Error: Gateway instance unavailable for sessions.create",
            });
          }
        }
      }
    } finally {
      channel.inbound.dispatch = originalDispatch;
      try {
        await waitFor("child model settlement", Promise.allSettled(childRuns));
      } finally {
        model.mockRestore();
        http.emit("close");
        projection.dispose();
        try {
          const children = rows().filter(({ sessionKey }) => sessionKey.includes(":dashboard:"));
          await waitFor(
            "child admission cleanup",
            Promise.all(
              children.flatMap(({ sessionKey, entry }) => {
                const drain = captureSessionControllerSettlement({
                  scope: childStore,
                  identities: [sessionKey, entry.sessionId],
                  agentId: "coder",
                });
                return drain ? [drain] : [];
              }),
            ),
          );
        } finally {
          markPluginRegistryRetired(builder.registry);
          networkCase = undefined;
        }
      }
    }
  });
});
