import assert from "node:assert/strict";
import { beforeAll, expect, it, vi } from "vitest";
import {
  createChannelAdmissionAudit,
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "../channels/message-access/admission-evidence.js";
import { importBundledChannelContractSourceArtifact } from "../channels/plugins/contracts/test-helpers/runtime-artifacts.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { runChannelInboundEvent } from "../plugin-sdk/channel-inbound.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { bindGatewayContextResolver } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

const transport = await vi.hoisted(async () => {
  const { createDeferred } = await import("../../test/helpers/promise.js");
  function nativeMessage(userId: string | undefined) {
    return {
      id: crypto.randomUUID(),
      userInfo: {
        userName: "viewer",
        displayName: "Viewer",
        userId,
        isMod: true,
        isBroadcaster: false,
        isVip: false,
        isSubscriber: false,
      },
    };
  }
  type NativeMessage = ReturnType<typeof nativeMessage>;
  class ChatClient {
    static ready: ((client: ChatClient) => void) | undefined;
    auth = new Set<() => void>();
    messages = new Set<
      (channel: string, user: string, text: string, message: NativeMessage) => void
    >();
    sent = createDeferred();
    say = vi.fn(async (_channel: string, _text: string) => this.sent.resolve());
    quit = vi.fn();
    onAuthenticationSuccess(handler: () => void) {
      this.auth.add(handler);
      return { unbind: () => this.auth.delete(handler) };
    }
    onAuthenticationFailure(this: void) {
      return { unbind() {} };
    }
    onDisconnect = this.onAuthenticationFailure;
    onMessage(
      handler: (channel: string, user: string, text: string, message: NativeMessage) => void,
    ) {
      this.messages.add(handler);
      ChatClient.ready?.(this);
      return { unbind: () => this.messages.delete(handler) };
    }
    connect() {
      for (const handler of this.auth) {
        handler();
      }
    }
    receive(userId: string | undefined) {
      // Native socket events arrive after connection-setup microtasks finish.
      setImmediate(() => {
        for (const handler of this.messages) {
          handler("#testchannel", "viewer", "@testbot hello", nativeMessage(userId));
        }
      });
    }
  }
  return { ChatClient, createDeferred };
});

const { twitchPlugin, setTwitchRuntime } = await importBundledChannelContractSourceArtifact<{
  twitchPlugin: ChannelPlugin<unknown>;
  setTwitchRuntime: (runtime: PluginRuntime) => void;
}>("twitch", "api.js", {
  "@twurple/chat": () => ({
    ChatClient: transport.ChatClient,
    LogLevel: { WARNING: "warning" },
  }),
});

type Policy = { allowFrom?: string[]; allowedRoles?: string[] };
const unknownEvidence = {
  ingressState: "unknown",
  invoker: { state: "unknown" },
  decisionCoverage: "unknown",
  identifierAuthentication: "unknown",
};

async function withTwitchMonitor(
  accountId = "default",
  policy: Policy = {},
  options: { collectionEnabled?: boolean; userId?: string | null; warmup?: boolean } = {},
) {
  return withOpenClawTestState({ label: "twitch-provenance" }, async (state) => {
    const accountConfig = {
      username: "testbot",
      accessToken: "synthetic-test-token",
      clientId: "synthetic-client",
      channel: "testchannel",
      ...policy,
    };
    const cfg: OpenClawConfig = {
      channels: { twitch: { accounts: { [accountId]: accountConfig } } },
    };
    await state.writeConfig(cfg);
    const rawEvidence: ReturnType<typeof readChannelContextAdmissionEvidence>[] = [];
    const evidence: ReturnType<typeof consumeChannelAdmissionEvidence>[] = [];
    const failure = transport.createDeferred<unknown[]>();
    const audit = createChannelAdmissionAudit({ enabled: options.collectionEnabled ?? true });
    const gateway = {
      channelAdmissionAudit: audit,
      getRuntimeConfig: () => cfg,
    } as GatewayRequestContext;
    const runtime = createPluginRuntime();
    bindGatewayContextResolver(runtime.subagent, () => gateway);
    runtime.channel.inbound.run = async (input) =>
      runChannelInboundEvent({
        ...input,
        adapter: {
          ...input.adapter,
          resolveTurn: async (...args) => {
            const turn = await input.adapter.resolveTurn(...args);
            assert(
              "delivery" in turn && turn.delivery.deliver,
              "Expected Twitch native reply delivery",
            );
            rawEvidence.push(readChannelContextAdmissionEvidence(turn.ctxPayload));
            evidence.push(consumeChannelAdmissionEvidence(rawEvidence.at(-1)));
            return {
              ...turn,
              // The real ingress queue owns adoption; outbound persistence is not this test's contract.
              delivery: { ...turn.delivery, durable: false },
              replyResolver: async () => ({ text: "reply" }),
            };
          },
        },
      });
    const builder = createTestPluginRegistry(runtime);
    const record = createPluginRecord({ id: "twitch", origin: "bundled" });
    const api = builder.createApi(record, { config: cfg, registrationMode: "full" });
    api.registerChannel({ plugin: twitchPlugin });
    builder.registry.plugins.push(record);
    markPluginRegistryActive(builder.registry);
    const registered = builder.registry.channels[0]?.resolveChannelRuntime?.();
    assert(registered, "Missing registered Twitch runtime");
    setTwitchRuntime(api.runtime);
    const abort = new AbortController();
    const ready = new Promise<InstanceType<typeof transport.ChatClient>>((resolve) => {
      transport.ChatClient.ready = resolve;
    });
    const runtimeEnv = createRuntimeEnv();
    runtimeEnv.error = vi.fn((...args) => failure.resolve(args));
    const ctx = {
      cfg,
      accountId,
      account: twitchPlugin.config.resolveAccount(cfg, accountId),
      channelRuntime: registered,
      abortSignal: abort.signal,
      runtime: runtimeEnv,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      setStatus() {},
      getStatus: () => ({ accountId }),
    };
    const start = twitchPlugin.gateway?.startAccount;
    const stop = twitchPlugin.gateway?.stopAccount;
    assert(start && stop, "Missing Twitch account lifecycle");
    const task = start(ctx);
    try {
      const client = await Promise.race([
        ready,
        task.then(() => {
          throw new Error("Twitch stopped before client registration");
        }),
      ]);
      if (!options.warmup) {
        client.receive(options.userId === null ? undefined : (options.userId ?? "123456"));
        expect(await Promise.race([client.sent.promise, failure.promise])).toBeUndefined();
        expect(client.say).toHaveBeenCalledExactlyOnceWith("testchannel", "reply");
      }
      expect(runtimeEnv.error).not.toHaveBeenCalled();
      return { rawEvidence, evidence };
    } finally {
      abort.abort();
      await task;
      await stop(ctx);
      transport.ChatClient.ready = undefined;
      audit.close();
      markPluginRegistryRetired(builder.registry);
    }
  });
}

beforeAll(() => withTwitchMonitor("default", {}, { warmup: true }));

it.each([
  ["secondary", { allowFrom: ["123456"] }, "allowlist", "enforced"],
  ["default", { allowedRoles: ["moderator"] }, "role", "enforced"],
  ["default", {}, "open", "attribution-only"],
  ["default", { allowedRoles: ["all"] }, "wildcard", "attribution-only"],
] satisfies [string, Policy, string, string][])(
  "preserves %s %j (%s) sender through actual ingress and reply",
  async (accountId, policy, name, coverage) => {
    const { evidence } = await withTwitchMonitor(accountId, policy);
    expect(evidence).toEqual([
      {
        ingressState: "present",
        invoker: {
          state: "present",
          kind: "person",
          rawPrincipalRef: JSON.stringify(["twitch", accountId, "123456"]),
        },
        assuranceRef: "channel-admission",
        decisionCoverage: coverage,
        identifierAuthentication: name === "open" ? "not-evaluated" : "evaluated",
      },
    ]);
  },
);

it.each([
  ["native user id absent", { allowedRoles: ["moderator"] }, null, true],
  ["collection disabled", { allowFrom: ["123456"] }, "123456", false],
] satisfies [string, Policy, string | null, boolean][])(
  "keeps replies but no attribution: %s",
  async (_name, policy, userId, collectionEnabled) => {
    const { evidence, rawEvidence } = await withTwitchMonitor("secondary", policy, {
      userId,
      collectionEnabled,
    });
    expect(evidence).toEqual([unknownEvidence]);
    if (!collectionEnabled) {
      expect(rawEvidence).toEqual([undefined]);
    }
  },
);
