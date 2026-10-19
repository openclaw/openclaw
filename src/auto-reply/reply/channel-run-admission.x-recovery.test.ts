import { beforeAll, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../channels/inbound-event/host-context-builder.js";
import {
  copyChildSessionPublication,
  readChildSessionPublication,
} from "../../channels/message-access/child-session-publication.js";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
  ResolveStableChannelMessageIngressParams,
} from "../../channels/message-access/runtime-types.js";
import { createHostChannelIngressRuntime } from "../../channels/message-access/runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getRawExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

type XPost = { id: string; author_id: string; conversation_id: string; text: string };
type Publication = ResolveStableChannelMessageIngressParams["childSessionPublication"];
type Snapshot = { assertCurrent: () => void };
const entry = (userId: string) => ({
  userId,
  username: "fixture",
  name: "Fixture",
  addedBy: "test",
  addedAt: 0,
});

const state = await setupAgentRunnerExecutionTestState();
const x = await loadBundledPluginFacade<{
  createKeyedState: () => PluginRuntime["state"]["openKeyedStore"];
  setXRuntime: (runtime: PluginRuntime) => void;
  openXAllowlist: (runtime: PluginRuntime) => {
    put(accountId: string, value: ReturnType<typeof entry>): Promise<void>;
    remove(accountId: string, userId: string): Promise<unknown>;
    readSnapshot(accountId: string): Promise<Snapshot>;
  };
  resolveXIngress: (
    accountId: string,
    post: XPost,
    cfg: OpenClawConfig,
    binding?: ChannelIngressContextBinding,
    publication?: Publication,
  ) => Promise<{ ingress: ResolvedChannelMessageIngress }>;
  createXPublicationPreparation: (params: {
    accountId: string;
    post: XPost;
    cfg: OpenClawConfig;
    readConfig: () => OpenClawConfig;
    route: { agentId: string; sessionKey: string };
    assertActive: () => void;
  }) => () => Promise<(() => void) | null>;
}>({ pluginId: "x", artifactBasename: "test-api.js" });
const executeAgentTurn = await getRawExecuteAgentTurnForTest();
let runWithModelFallback: typeof import("../../agents/model-fallback-runner.js").runWithModelFallback;
beforeAll(async () => {
  // The shared fixture stubs provider execution. Restore the real candidate loop here.
  vi.doUnmock("../../agents/model-fallback-attempt.js");
  ({ runWithModelFallback } = await vi.importActual<
    typeof import("../../agents/model-fallback-runner.js")
  >("../../agents/model-fallback-runner.js"));
});

it.each([
  ["unrelated mutation", 1, 2],
  ["revoked author", 0, 2],
  ["changed route", 0, 1],
  ["continuous mutation", 0, 4],
  ["one policy race", 1, 3],
  ["retired owner", 0, 2],
  ["unavailable authorization", 0, 2],
] as const)(
  "X %s renews policy or drops without model failover or a public error",
  async (scenario, modelCalls, resolutions) => {
    await withOpenClawTestState({ label: "x-authorization-runner" }, async (testState) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        channels: {
          x: {
            userId: "100",
            allowFrom: [],
            groupPolicy: "allowlist",
            autoPublishWorkSessions: true,
          },
        },
      };
      let currentConfig = cfg;
      const post = { id: "501", author_id: "30", conversation_id: "500", text: "@bot help" };
      const gateway = { getRuntimeConfig: () => currentConfig } as GatewayRequestContext;
      let ownerActive = true;
      const owner = {
        channelId: "x",
        isLive: () => ownerActive,
        resolveGatewayContext: () => gateway,
      };
      const hostIngress = createHostChannelIngressRuntime(owner);
      const resolveStable = vi.fn(hostIngress.resolveStable);
      const runtime = {
        state: { openKeyedStore: x.createKeyedState(), resolveStateDir: () => testState.stateDir },
        channel: { inbound: { ingress: { resolveStable } } },
      } as unknown as PluginRuntime;
      x.setXRuntime(runtime);
      const allowlist = x.openXAllowlist(runtime);
      await allowlist.put("default", entry("30"));
      const route = resolveAgentRoute({
        cfg,
        channel: "x",
        accountId: "default",
        peer: { kind: "group", id: "500" },
      });
      const snapshot = await allowlist.readSnapshot("default");
      const publication = {
        audience: "public" as const,
        assertCurrent: snapshot.assertCurrent,
        prepare: x.createXPublicationPreparation({
          accountId: "default",
          post,
          cfg,
          readConfig: () => currentConfig,
          route,
          assertActive: () => {},
        }),
      };
      const authorization = await x.resolveXIngress(
        "default",
        post,
        cfg,
        {
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          messageId: post.id,
          inboundEventKind: "user_request",
        },
        publication,
      );
      const context = await createHostChannelInboundEventContextBuilder(
        buildChannelInboundEventContext,
        owner,
      )({
        channel: "x",
        accountId: "default",
        messageId: post.id,
        channelIngress: authorization.ingress,
        from: "x:group:500",
        sender: { id: "30" },
        conversation: { kind: "group", id: "500" },
        route: { agentId: route.agentId, routeSessionKey: route.sessionKey },
        reply: { to: "x:501" },
        message: { body: post.text, rawBody: post.text },
      });
      const followup = createFollowupRun();
      followup.run.sessionKey = route.sessionKey;
      followup.run.config = cfg;
      copyChildSessionPublication(context, followup.run);
      await allowlist.put("default", entry("40"));
      expect(() => snapshot.assertCurrent()).toThrow("allowlist changed");
      if (scenario === "revoked author") {
        await allowlist.remove("default", "30");
      } else if (scenario === "changed route") {
        currentConfig = { ...cfg, bindings: [{ agentId: "other", match: { channel: "x" } }] };
      } else if (scenario === "unavailable authorization") {
        resolveStable.mockRejectedValue(new Error("authorization storage unavailable"));
      } else if (["retired owner", "one policy race", "continuous mutation"].includes(scenario)) {
        const mutate = async (params: Parameters<typeof hostIngress.resolveStable>[0]) => {
          const result = await hostIngress.resolveStable(params);
          if (scenario === "retired owner") {
            ownerActive = false;
          } else {
            await allowlist.put("default", entry("40"));
          }
          return result;
        };
        if (scenario === "one policy race") {
          resolveStable.mockImplementationOnce(mutate);
        } else {
          resolveStable.mockImplementation(mutate);
        }
      }
      const selected: string[] = [];
      state.runWithModelFallbackMock.mockImplementation((params) =>
        runWithModelFallback({
          ...params,
          skipAuthProfileRuntime: true,
          manifestPlugins: [],
          fallbacksOverride: ["openai/fallback"],
          run: async (provider, model, options) => {
            selected.push(provider);
            return params.run(provider, model, options);
          },
        }),
      );
      const model = vi.fn();
      state.runEmbeddedAgentMock.mockImplementation(async (params) => {
        const admitted = await params.preparedRunAdmission.admit("embedded");
        expect(readChildSessionPublication(admitted.operationalRunInstance)).toBeDefined();
        model();
        return { payloads: [{ text: "Authorized reply" }], meta: { durationMs: 0 } };
      });
      const result = await executeAgentTurn(
        createMinimalRunAgentTurnParams({ followupRun: followup, sessionCtx: context }),
      );
      expect(selected).toEqual(["anthropic"]);
      expect(model).toHaveBeenCalledTimes(modelCalls);
      expect(resolveStable).toHaveBeenCalledTimes(resolutions);
      if (modelCalls) {
        expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
      } else {
        expect(result.outcome).toMatchObject({
          kind: "rejected",
          payload: {
            text:
              scenario === "unavailable authorization"
                ? expect.stringContaining("could not verify current channel access")
                : SILENT_REPLY_TOKEN,
          },
        });
      }
    });
  },
);
