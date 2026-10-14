import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../channels/inbound-event/host-context-builder.js";
import {
  copyChildSessionPublication,
  readChildSessionPublication,
} from "../../channels/message-access/child-session-publication.js";
import type {
  ChannelIngressContextBinding,
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
type IngressResult = Snapshot & {
  ingress: Awaited<ReturnType<PluginRuntime["channel"]["inbound"]["ingress"]["resolveStable"]>>;
  tier: "maintainer" | "guest";
};

const state = await setupAgentRunnerExecutionTestState();
const {
  createKeyedState,
  createXPublicationPreparation,
  openXAllowlist,
  resolveXIngress,
  setXRuntime,
} = await loadBundledPluginFacade<{
  createKeyedState(this: void): PluginRuntime["state"]["openKeyedStore"];
  setXRuntime(this: void, runtime: PluginRuntime): void;
  openXAllowlist(
    this: void,
    runtime: PluginRuntime,
  ): {
    put(
      accountId: string,
      entry: { userId: string; username: string; name: string; addedBy: string; addedAt: number },
    ): Promise<void>;
    remove(accountId: string, userId: string): Promise<unknown>;
    readSnapshot(accountId: string): Promise<Snapshot>;
  };
  resolveXIngress(
    this: void,
    accountId: string,
    post: XPost,
    cfg: OpenClawConfig,
    binding?: ChannelIngressContextBinding,
    publication?: Publication,
  ): Promise<IngressResult>;
  createXPublicationPreparation(
    this: void,
    params: {
      accountId: string;
      post: XPost;
      cfg: OpenClawConfig;
      readConfig: () => OpenClawConfig;
      route: { agentId: string; sessionKey: string };
      assertActive: () => void;
    },
  ): () => Promise<(() => void) | null>;
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

describe("X ingress authorization through reply runner", () => {
  it.each([
    "unrelated mutation",
    "revoked author",
    "changed route",
    "continuous mutation",
    "one policy race",
    "retired owner",
    "unavailable authorization",
  ] as const)(
    "%s renews policy or drops without model failover or a public error",
    async (scenario) => {
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
          state: { openKeyedStore: createKeyedState(), resolveStateDir: () => testState.stateDir },
          channel: { inbound: { ingress: { resolveStable } } },
        } as unknown as PluginRuntime;
        setXRuntime(runtime);
        const allowlist = openXAllowlist(runtime);
        const entry = (userId: string) => ({
          userId,
          username: "fixture",
          name: "Fixture",
          addedBy: "test",
          addedAt: 0,
        });
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
          prepare: createXPublicationPreparation({
            accountId: "default",
            post,
            cfg,
            readConfig: () => currentConfig,
            route,
            assertActive: () => {},
          }),
        };
        const authorization = await resolveXIngress(
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
        } else if (scenario === "retired owner") {
          resolveStable.mockImplementation(async (params) => {
            const result = await hostIngress.resolveStable(params);
            ownerActive = false;
            return result;
          });
        } else if (scenario === "one policy race") {
          resolveStable.mockImplementationOnce(async (params) => {
            const result = await hostIngress.resolveStable(params);
            await allowlist.put("default", entry("40"));
            return result;
          });
        } else if (scenario === "continuous mutation") {
          resolveStable.mockImplementation(async (params) => {
            const result = await hostIngress.resolveStable(params);
            await allowlist.put("default", entry("40"));
            return result;
          });
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
        if (scenario === "unrelated mutation" || scenario === "one policy race") {
          expect(model).toHaveBeenCalledOnce();
          expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
        } else if (scenario === "unavailable authorization") {
          expect(model).not.toHaveBeenCalled();
          expect(result.outcome).toMatchObject({
            kind: "rejected",
            payload: { text: expect.stringContaining("could not verify current channel access") },
          });
        } else {
          expect(model).not.toHaveBeenCalled();
          expect(result.outcome).toMatchObject({
            kind: "rejected",
            payload: { text: SILENT_REPLY_TOKEN },
          });
        }
        expect(resolveStable).toHaveBeenCalledTimes(
          scenario === "changed route"
            ? 1
            : scenario === "continuous mutation"
              ? 4
              : scenario === "one policy race"
                ? 3
                : 2,
        );
      });
    },
  );
});
