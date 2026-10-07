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
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as ssrfRuntime from "../plugin-sdk/ssrf-runtime.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createPluginServiceScheduler } from "../plugins/service-scheduler.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
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

type Case = "allowed" | "guest" | "revoked";
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
const appToken = "synthetic-x-composition-app-token";
const userToken = "synthetic-x-composition-user-token";

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

function post(id: string, root: string, author: string, text: string): Post {
  return {
    id,
    author_id: author,
    conversation_id: root,
    text,
    created_at: "2026-10-01T12:00:00.000Z",
  };
}

describe("X publication production-owner composition", () => {
  installGatewayTestHooks();

  it("commits and anonymously reads maintainer work; denies guest and revoked creation", async ({
    signal,
  }) => {
    const channels: OpenClawConfig["channels"] = {
      x: {
        userId: "100",
        username: "proofbot",
        clientId: "synthetic-client",
        clientSecret: "synthetic-client-secret",
        refreshToken: "synthetic-refresh-token",
        bearerToken: appToken,
        allowFrom: ["x:10"],
        groupPolicy: "allowlist",
        autoPublishWorkSessions: true,
        guests: { enabled: true },
        events: { mode: "poll", pollSeconds: 60 },
        replySignature: "",
      },
    };
    clearRuntimeConfigSnapshot();
    const config: OpenClawConfig = {
      ...getRuntimeConfig(),
      agents: {
        defaults: {
          ...getRuntimeConfig().agents?.defaults,
          model: { primary: "x-proof/proof-model" },
        },
        entries: { main: { skills: [], tools: { fs: { workspaceOnly: true } } } },
      },
      channels,
      messages: { queue: { mode: "collect" }, inbound: { debounceMs: 0 } },
      skills: { load: { watch: false } },
      gateway: { publicOrigin: "https://public-proof.example.test" },
      tools: { codeMode: false },
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
    gateway.readPreparedGatewayModelCatalog = async () => {
      const catalog = await gateway.loadGatewayModelCatalogSnapshot();
      return { entries: catalog.entries, routeVariants: catalog.routeVariants };
    };
    const runtime = createPluginRuntime();
    bindGatewayContextResolver(runtime.subagent, () => gateway);
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const builder = createPluginRegistry({ logger, runtime, activateGlobalSideEffects: false });
    const record = createPluginRecord({ id: "x", origin: "bundled" });
    const api = builder.createApi(record, { config: cfg(), registrationMode: "full" });
    api.registerChannel({ plugin: xPlugin });
    builder.registry.plugins.push(record);
    markPluginRegistryActive(builder.registry);
    setTestPluginRegistry(builder.registry);
    const instance = expectDefined(getPluginInstance(record), "registered X instance");
    instance.run(() => setXRuntime(api.runtime));
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
    let creating = false;
    let revokedInCatalogWait = false;
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
              }
            },
          },
        ],
        builder.registry,
      );

    const outcomes = new Map<Case, unknown>();
    const publications = new Map<Case, boolean>();
    const childWritten = Promise.withResolvers<string>();
    const childRuns = new Set<Promise<unknown>>();
    const model = vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async (params) => {
      const admitted =
        params.admittedRunContext ??
        (await expectDefined(params.preparedRunAdmission, "production reply-owned admission").admit(
          "embedded",
        ));
      const key = expectDefined(params.sessionKey, "admitted session key");
      console.info("[x-proof] model admitted", key);
      const child = key.includes(":dashboard:");
      const work = (async () => {
        if (
          params.userTurnTranscriptRecorder &&
          !params.userTurnTranscriptRecorder.hasPersisted()
        ) {
          expect(await params.userTurnTranscriptRecorder.persistApproved()).toBeTruthy();
        }
        params.onExecutionPhase?.({ phase: "model_call_started" });
        let text = "Synthetic X invocation settled.";
        if (!child) {
          const publication = readChildSessionPublication(admitted.operationalRunInstance);
          publications.set(activeCase, publication !== undefined);
          publication?.assertCurrent();
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
                runtimeToolAllowlist: ["sessions_spawn"],
                toolConstructionPlan: {
                  includeBaseCodingTools: false,
                  includeShellTools: false,
                  includeChannelTools: false,
                  includeOpenClawTools: true,
                  includePluginTools: false,
                },
              });
              const spawn = expectDefined(
                tools.find((tool) => tool.name === "sessions_spawn"),
                "real sessions_spawn tool",
              );
              return spawn.execute("x-proof-" + activeCase, {
                task: "Persist the synthetic publication composition answer.",
                label: "X publication " + activeCase,
                runtime: "subagent",
                visible: true,
                context: "isolated",
                expectsCompletionMessage: false,
              });
            });
            outcomes.set(activeCase, result.details);
            console.info("[x-proof] spawn result", activeCase, result.details);
          } catch (error) {
            outcomes.set(activeCase, { error: String(error) });
            console.info("[x-proof] spawn error", activeCase, String(error));
          }
        } else {
          text = "X publication composition: durable child answer.";
        }
        const appended = await appendTranscriptMessage(
          {
            agentId: "main",
            sessionKey: key,
            sessionId: params.sessionId,
            storePath: sessionStore,
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
      })();
      if (child) {
        childRuns.add(work);
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
      },
    });
    const channel = api.runtime.channel;
    const originalDispatch = channel.inbound.dispatch;
    let dispatched = Promise.withResolvers<void>();
    // Pass-through observation only: no replacement result or ingress capability.
    channel.inbound.dispatch = async (...args) => {
      console.info("[x-proof] real dispatch entered", activeCase);
      try {
        const result = await originalDispatch(...args);
        dispatched.resolve();
        return result;
      } catch (error) {
        dispatched.reject(error);
        throw error;
      }
    };
    const rows = () => listSessionEntriesCore({ agentId: "main", storePath: sessionStore });
    try {
      for (const [index, kind] of (["allowed", "guest", "revoked"] as const).entries()) {
        activeCase = kind;
        dispatched = Promise.withResolvers<void>();
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
          await withinTest(
            awaitGateBeforeSettlement(
              dispatched.promise,
              monitor,
              "X monitor ended before production reply dispatch",
            ),
            signal,
          );
        } finally {
          abort.abort();
          try {
            await monitor;
          } finally {
            await scheduling.close();
          }
        }
        expect(networkCase.replies).toHaveLength(1);
        const publicReads = networkCase.reads.filter((request) => request.appOnly);
        if (kind === "guest") {
          expect(publicReads).toEqual([]);
          expect(publications.get(kind)).toBe(false);
          expect(outcomes.get(kind)).toMatchObject({
            status: "forbidden",
            error: expect.stringContaining("hidden helpers"),
          });
          expect(creationRequests.filter((request) => request.kind === kind)).toEqual([]);
        } else {
          expect(publicReads).toEqual([
            { path: "/2/tweets", appOnly: true, ids: expect.arrayContaining([rootId, mention.id]) },
          ]);
          expect(publications.get(kind)).toBe(true);
          expect(creationRequests.filter((request) => request.kind === kind)).toHaveLength(1);
          if (kind === "allowed") {
            expect(outcomes.get(kind)).toMatchObject({ status: "accepted", publicRead: true });
            const key = await withinTest(childWritten.promise, signal);
            const entry = expectDefined(
              loadSessionEntry({ agentId: "main", sessionKey: key, storePath: sessionStore }),
              "committed child row",
            );
            const publication = expectDefined(
              resolveSessionPublicShare(entry),
              "committed child publication",
            );
            expect(publication.sessionId).toBe(entry.sessionId);
            // The append checkpoint precedes the run's final session metadata writes.
            const childReleased = getSessionWorkAdmissionRelease({
              scope: sessionStore,
              identities: [key, entry.sessionId],
            });
            if (childReleased) {
              await withinTest(childReleased, signal);
            }
            await withinTest(projection.prepareMembership(), signal);
            expect(
              isPublicSessionShareActive(
                cfg(),
                {
                  agentId: "main",
                  sessionKey: key,
                  sessionId: publication.sessionId,
                  shareId: publication.id,
                },
                projection,
              ),
            ).toBe(true);
            const response = await sendRequest(http, {
              path: new URL(
                expectDefined(
                  resolveControlUiSessionUrl(cfg(), { sessionKey: key }),
                  "canonical child URL",
                ),
              ).pathname,
              host: "localhost",
              remoteAddress: "127.0.0.1",
            });
            expect(response.res.statusCode, response.getBody()).toBe(200);
            expect(response.getBody()).toContain(
              "X publication composition: durable child answer.",
            );
            expect(response.getBody()).not.toContain("openclaw-app");
          } else {
            expect(revokedInCatalogWait).toBe(true);
            expect(outcomes.get(kind)).toMatchObject({
              error: expect.stringContaining("publication policy changed"),
            });
          }
        }
        expect(rows().filter(({ entry }) => resolveSessionPublicShare(entry))).toHaveLength(1);
        expect(
          rows().filter(({ entry }) => entry.parentSessionKey === "agent:main:x:group:" + rootId),
        ).toHaveLength(kind === "allowed" ? 1 : 0);
      }
    } finally {
      channel.inbound.dispatch = originalDispatch;
      await Promise.allSettled(childRuns);
      model.mockRestore();
      http.emit("close");
      projection.dispose();
      const children = rows().filter(({ sessionKey }) => sessionKey.includes(":dashboard:"));
      await Promise.all(
        children.flatMap(({ sessionKey, entry }) => {
          const drain = getSessionWorkAdmissionRelease({
            scope: sessionStore,
            identities: [sessionKey, entry.sessionId],
          });
          return drain ? [drain] : [];
        }),
      );
      markPluginRegistryRetired(builder.registry);
      networkCase = undefined;
    }
  });
});
