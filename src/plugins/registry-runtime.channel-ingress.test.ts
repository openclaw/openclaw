import { AsyncResource } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import {
  createChannelAdmissionAudit,
  readChannelContextGatewayContextResolver,
  type ChannelAdmissionAudit,
} from "../channels/message-access/admission-evidence.js";
import type { ResolvedChannelMessageIngress } from "../channels/message-access/runtime-types.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  resolveStableChannelMessageIngress,
} from "../plugin-sdk/channel-ingress-runtime.js";
import { recordAcceptedSessionParticipantInput } from "../sessions/session-participant-input-recording.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  withPluginRegistryPreparationScope,
} from "./registry-lifecycle.js";
import {
  contextParams,
  createRuntimeBuilder,
  inspect,
  resolveIngressForRuntime,
} from "./registry-runtime.channel-ingress.test-support.js";
import { createPluginRegistry } from "./registry.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  hasGatewayContextOwner,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: recordParticipant,
}));

function expectIngressState(context: object, state: "present" | "unknown") {
  expect(inspect(context)).toMatchObject({ ingressState: state, invoker: { state } });
}
function expectIngress(
  build: typeof buildChannelInboundEventContext,
  params: Parameters<typeof contextParams>[0],
  state: "present" | "unknown",
) {
  expectIngressState(build(contextParams(params)), state);
}
const audits = new Set<ChannelAdmissionAudit>();
const fullRegistration = { config: {}, registrationMode: "full" as const };
const sessionKey = "agent:main:channel-owner:dm:dm-1";
const ingressBinding = {
  agentId: "main",
  sessionKey,
  messageId: "message-1",
  inboundEventKind: "user_request" as const,
};
function route(overrides: Partial<Parameters<typeof contextParams>[0]["route"]> = {}) {
  return { agentId: "main", routeSessionKey: sessionKey, ...overrides };
}
function group(overrides: Partial<Parameters<typeof contextParams>[0]["conversation"]> = {}) {
  return { kind: "group" as const, id: "room-1", parentId: "parent-1", ...overrides };
}
function expectProvenance(context: object, audit?: ChannelAdmissionAudit) {
  expect(inspect(context)).toMatchObject({ ingressState: audit ? "present" : "unknown" });
  const resolver = readChannelContextGatewayContextResolver(context);
  if (audit) {
    expect(resolver?.()?.channelAdmissionAudit).toBe(audit);
  } else {
    expect(resolver).toBeUndefined();
  }
}
function bundledRuntime(audit = createAudit()) {
  return createRuntimeBuilder({ origin: "bundled", audit });
}
function recordInput(context: Parameters<typeof recordAcceptedSessionParticipantInput>[0]) {
  recordAcceptedSessionParticipantInput(context, {
    agentId: "main",
    sessionKey,
    storePath: "/unused",
  });
}
function createRegistry(runtime: PluginRuntime = createPluginRuntime()) {
  return createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
    activateGlobalSideEffects: false,
  });
}

function channelFixture(id: string, label = id): ChannelPlugin {
  return {
    id,
    meta: { id, label, selectionLabel: label, docsPath: `/channels/${id}`, blurb: "test channel" },
    capabilities: { chatTypes: ["direct"] },
    config: { listAccountIds: () => [], resolveAccount: () => ({ accountId: "default" }) },
    outbound: { deliveryMode: "direct" },
  };
}

function createGateway(audit: ChannelAdmissionAudit) {
  return { channelAdmissionAudit: audit, getRuntimeConfig: () => ({}) } as GatewayRequestContext;
}

function createAudit() {
  const audit = createChannelAdmissionAudit({ enabled: true });
  audits.add(audit);
  return audit;
}
afterEach(() => {
  for (const audit of audits) {
    audit.close();
  }
  audits.clear();
});

it.each([
  "loadAdapter",
  "setIdleTimeoutBySessionKey",
  "setMaxAgeBySessionKey",
  "setIdleTimeoutBySessionKeyAsync",
  "setMaxAgeBySessionKeyAsync",
] as const)(
  "keeps adopted channel %s usable after its captured registry is collected",
  async (method) => {
    class RetainedService {
      id = "retired-channel-scope";
      start() {}
    }
    const registryBuilder = createRegistry();
    const record = createPluginRecord({ id: "adopted-channel", origin: "bundled" });
    const api = registryBuilder.createApi(record, { config: {} });
    const instance = getPluginInstance(record)!;
    const binding = { boundAt: 1, lastActivityAt: 2 };
    const bindings = {
      setIdleTimeoutBySessionKey: vi.fn(() => [binding]),
      setMaxAgeBySessionKey: vi.fn(() => [binding]),
      setIdleTimeoutBySessionKeyAsync: vi.fn(async () => [binding]),
      setMaxAgeBySessionKeyAsync: vi.fn(async () => [binding]),
    };
    api.registerChannel({
      plugin: {
        ...channelFixture(record.id),
        conversationBindings: bindings,
      },
    });
    registryBuilder.registry.plugins.push(record);
    markPluginRegistryActive(registryBuilder.registry);
    const capturedChannel = api.runtime.channel;
    const current = createEmptyPluginRegistry();
    current.plugins.push(record);
    current.channels.push(...registryBuilder.registry.channels);
    const resource = (() => {
      const intermediate = createEmptyPluginRegistry();
      intermediate.plugins.push(record);
      intermediate.channels.push(...registryBuilder.registry.channels);
      intermediate.services.push({
        id: "retired-channel-scope",
        pluginId: record.id,
        source: "retention-test",
        origin: "config",
        service: new RetainedService(),
      });
      markPluginRegistryActive(intermediate);
      markPluginRegistryRetired(registryBuilder.registry);
      const captured = instance.run(() => new AsyncResource("adopted-channel-runtime"));
      markPluginRegistryActive(current);
      markPluginRegistryRetired(intermediate);
      return captured;
    })();
    const input = { channelId: record.id, targetSessionKey: "agent:main:channel:dm:fixture" };
    const invoke = (channel: PluginRuntime["channel"]) => {
      if (method === "loadAdapter") {
        return channel.outbound.loadAdapter(record.id);
      }
      if (method === "setIdleTimeoutBySessionKey" || method === "setIdleTimeoutBySessionKeyAsync") {
        return channel.threadBindings[method]({ ...input, idleTimeoutMs: 10 });
      }
      return channel.threadBindings[method]({ ...input, maxAgeMs: 20 });
    };
    try {
      await setImmediate();
      expect(queryObjects(RetainedService)).toBe(0);
      for (const readChannel of [() => capturedChannel, () => api.runtime.channel]) {
        const result = await resource.runInAsyncScope(() => invoke(readChannel()));
        if (method === "loadAdapter") {
          expect(result).toBe(current.channels[0]?.plugin.outbound);
        } else {
          expect(result).toEqual([binding]);
        }
      }
      if (method === "loadAdapter") {
        const empty = createEmptyPluginRegistry();
        await withPluginRuntimeRegistryScope(empty, async () => {
          expect(await capturedChannel.outbound.loadAdapter(record.id)).toBeUndefined();
        });
        expect(empty.channels).toHaveLength(0);
      }
      if (method !== "loadAdapter") {
        expect(bindings[method]).toHaveBeenCalledTimes(2);
        expect(bindings[method]).toHaveBeenLastCalledWith({
          targetSessionKey: input.targetSessionKey,
          accountId: undefined,
          ...(method.includes("Idle") ? { idleTimeoutMs: 10 } : { maxAgeMs: 20 }),
        });
      }
    } finally {
      resource.emitDestroy();
      markPluginRegistryRetired(current);
      await instance.dispose();
    }
  },
);

type LegacyIngressMethod = "direct" | "stable" | "factory";

function createLegacyReceiver(params: {
  audit: ChannelAdmissionAudit;
  trusted?: boolean;
  readStoreAllowFrom?: () => Promise<string[]>;
}) {
  const identity = {
    resolveParticipant: (subject: { stableId?: string | number | null }) => ({
      domain: "workspace-one",
      idKind: "user-id",
      id: String(subject.stableId),
    }),
  };
  const input = {
    channelId: "channel-owner",
    accountId: "default",
    subject: { stableId: "person-a" },
    conversation: { kind: "direct" as const, id: "dm-1" },
    contextBinding: ingressBinding,
    dmPolicy: params.readStoreAllowFrom ? ("pairing" as const) : ("allowlist" as const),
    allowFrom: ["person-a"],
    readStoreAllowFrom: params.readStoreAllowFrom,
    useDefaultPairingStore: false,
  };
  let resolvers!: Record<LegacyIngressMethod, () => Promise<ResolvedChannelMessageIngress>>;
  let receiveIngress!: () => Promise<ResolvedChannelMessageIngress>;
  const channel = createRuntimeBuilder({
    origin: "global",
    trustedOfficialInstall: params.trusted !== false,
    audit: params.audit,
    prepare: (api) => {
      const descriptor = defineStableChannelIngressIdentity(identity);
      // The released factory is created before registerChannel publishes its owner.
      const factory = createChannelIngressResolver({ ...input, identity: descriptor });
      resolvers = {
        direct: () =>
          resolveChannelMessageIngress({
            ...input,
            identity: descriptor,
            event: { kind: "message", authMode: "inbound", mayPair: true },
            policy: { dmPolicy: input.dmPolicy, groupPolicy: "disabled" },
          }),
        stable: () => resolveStableChannelMessageIngress({ ...input, identity }),
        factory: () => factory.message(input),
      };
      return {
        startAccount: async () => {
          const buildContext = api.runtime.channel.inbound.buildContext;
          const ingress = await receiveIngress();
          return buildContext(contextParams({ ingress }));
        },
      };
    },
  });
  return {
    ...channel,
    resolvers,
    receive: async (resolve: () => Promise<ResolvedChannelMessageIngress>) => {
      receiveIngress = resolve;
      const startAccount =
        channel.registryBuilder.registry.channels[0]!.plugin.gateway!.startAccount!;
      return (await startAccount({} as never)) as ReturnType<
        typeof buildChannelInboundEventContext
      >;
    },
    dispose: async () => {
      markPluginRegistryRetired(channel.registryBuilder.registry);
      await channel.instance!.dispose();
    },
  };
}

describe("bundled channel ingress runtime ownership", () => {
  it("never binds a registration-time factory to another live instance of the same channel", async () => {
    const firstAudit = createAudit();
    const secondAudit = createAudit();
    const first = createLegacyReceiver({ audit: firstAudit });
    const second = createLegacyReceiver({ audit: secondAudit });
    try {
      const foreign = await second.receive(first.resolvers.factory);
      expectProvenance(foreign);
      const original = await first.receive(first.resolvers.factory);
      expectProvenance(original, firstAudit);
      const independent = await second.receive(second.resolvers.factory);
      expectProvenance(independent, secondAudit);
      await first.dispose();
      const retired = await second.receive(first.resolvers.factory);
      expectProvenance(retired);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it("drops released-helper provenance when its owner retires during policy resolution", async () => {
    const audit = createAudit();
    const entered = createDeferredCore();
    const allowFrom = createDeferredCore<string[]>();
    const channel = createLegacyReceiver({
      audit,
      readStoreAllowFrom: () => {
        entered.resolve();
        return allowFrom.promise;
      },
    });
    try {
      const pending = channel.receive(channel.resolvers.direct);
      await entered.promise;
      markPluginRegistryRetired(channel.registryBuilder.registry);
      allowFrom.resolve([]);
      const context = await pending;
      expectProvenance(context);
    } finally {
      allowFrom.resolve([]);
      await channel.dispose();
    }
  });

  it("retains released helpers when the exact channel instance moves to a new registry", async () => {
    const audit = createAudit();
    const channel = createLegacyReceiver({ audit });
    const next = createEmptyPluginRegistry();
    next.plugins.push(channel.record);
    next.channels.push(...channel.registryBuilder.registry.channels);
    try {
      markPluginRegistryActive(next);
      markPluginRegistryRetired(channel.registryBuilder.registry);
      for (const method of ["direct", "stable", "factory"] as const) {
        recordParticipant.mockClear();
        const context = await channel.receive(channel.resolvers[method]);
        expect(inspect(context)).toMatchObject({
          ingressState: "present",
          invoker: { state: "present", kind: "person" },
          decisionCoverage: "enforced",
        });
        expect(readChannelContextGatewayContextResolver(context)?.()?.channelAdmissionAudit).toBe(
          audit,
        );
        recordInput(context);
        expect(recordParticipant).toHaveBeenLastCalledWith(
          expect.objectContaining({
            identity: {
              type: "remote",
              pluginId: "channel-owner",
              domain: "workspace-one",
              idKind: "user-id",
              id: "person-a",
            },
          }),
        );
      }
      next.channels.splice(0);
      const removed = await channel.receive(channel.resolvers.factory);
      expectProvenance(removed);
    } finally {
      markPluginRegistryRetired(next);
      await channel.dispose();
    }
  });

  it("keeps unqualified released helpers policy-only even beside a trusted channel", async () => {
    const audit = createAudit();
    const trusted = createLegacyReceiver({ audit });
    const untrusted = createLegacyReceiver({ audit, trusted: false });
    try {
      for (const method of ["direct", "stable", "factory"] as const) {
        const outside = await trusted.resolvers[method]();
        expect(outside.ingress.admission).toBe("dispatch");
        const context = trusted.buildContext(contextParams({ ingress: outside }));
        expectProvenance(context);
        const external = await untrusted.receive(untrusted.resolvers[method]);
        expect(readChannelContextGatewayContextResolver(external)).toBeUndefined();
        recordParticipant.mockClear();
        recordInput(external);
        expect(recordParticipant).not.toHaveBeenCalled();
      }
    } finally {
      await trusted.dispose();
      await untrusted.dispose();
    }
  });

  it.each(["bundled", "global"] as const)(
    "retains the host Gateway resolver for a trusted %s channel ingress",
    async (origin) => {
      const gatewayContext = {} as GatewayRequestContext;
      const gatewayContextResolver = vi.fn(() => gatewayContext);
      const channel = createRuntimeBuilder({
        origin,
        trustedOfficialInstall: origin !== "bundled",
        gatewayContextResolver,
      });
      const apiInbound = channel.api.runtime.channel.inbound;
      expect(apiInbound.ingress).toBe(channel.ingress);
      expect(apiInbound.buildContext).toBe(channel.buildContext);
      const ingress = await channel.resolveIngress("person-a");
      const context = apiInbound.buildContext(contextParams({ ingress }));

      const retainedResolver = readChannelContextGatewayContextResolver(context);
      expect(retainedResolver?.()).toBe(gatewayContext);
      expect(hasGatewayContextOwner(retainedResolver!, gatewayContextResolver)).toBe(true);
      markPluginRegistryRetired(channel.registryBuilder.registry);
      expect(retainedResolver?.()).toBeUndefined();
      const retiredIngress = await channel.resolveIngress("person-a");
      expect(
        readChannelContextGatewayContextResolver(
          apiInbound.buildContext(contextParams({ ingress: retiredIngress })),
        ),
      ).toBeUndefined();
    },
  );

  it("binds authenticated owner turns to the exact live trusted channel plugin", async () => {
    const runtime = createPluginRuntime();
    const command = vi.fn(async () => ({ payloads: [] }));
    Object.defineProperty(runtime.agent, "runCommandFromIngress", {
      configurable: true,
      value: command,
    });
    const registryBuilder = createRegistry(runtime);
    const owner = createPluginRecord({ id: "discord", origin: "bundled" });
    const foreign = createPluginRecord({ id: "foreign", origin: "bundled" });
    const untrusted = createPluginRecord({ id: "impostor", origin: "workspace" });
    const ownerApi = registryBuilder.createApi(owner, { config: {} });
    const foreignApi = registryBuilder.createApi(foreign, { config: {} });
    const untrustedApi = registryBuilder.createApi(untrusted, { config: {} });
    registryBuilder.registry.plugins.push(owner, foreign, untrusted);
    registryBuilder.registry.channels.push(
      {
        pluginId: "discord",
        plugin: { id: "discord" },
        source: owner.source,
      } as never,
      {
        pluginId: "impostor",
        plugin: { id: "community" },
        source: untrusted.source,
      } as never,
    );
    markPluginRegistryActive(registryBuilder.registry);
    const options = {
      message: "owner turn",
      messageChannel: "discord" as const,
      senderIsOwner: true,
      allowModelOverride: false,
    };
    const commandRuntime = { log: vi.fn(), error: vi.fn() } as never;
    const retained = ownerApi.runtime.agent.runCommandFromIngress;

    await expect(retained(options, commandRuntime)).resolves.toEqual({ payloads: [] });
    expect(command).toHaveBeenCalledWith(options, commandRuntime);
    await expect(
      foreignApi.runtime.agent.runCommandFromIngress(options, commandRuntime),
    ).rejects.toThrow('Plugin "foreign" cannot admit authenticated owner authority');
    const guestOptions = { ...options, messageChannel: "community", senderIsOwner: false };
    const retainedGuest = untrustedApi.runtime.agent.runCommandFromIngress;
    await expect(retainedGuest(guestOptions, commandRuntime)).resolves.toEqual({ payloads: [] });
    expect(command).toHaveBeenLastCalledWith(guestOptions, commandRuntime);
    let ownerClaimReads = 0;
    let channelReads = 0;
    const changingGuestOptions = {
      ...guestOptions,
      get senderIsOwner() {
        return ownerClaimReads++ > 0;
      },
      get messageChannel() {
        return channelReads++ === 0 ? "community" : "discord";
      },
    };
    await expect(retainedGuest(changingGuestOptions, commandRuntime)).resolves.toEqual({
      payloads: [],
    });
    expect(command).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageChannel: "community", senderIsOwner: false }),
      commandRuntime,
    );
    expect({ ownerClaimReads, channelReads }).toEqual({ ownerClaimReads: 1, channelReads: 1 });
    await expect(
      retainedGuest({ ...guestOptions, senderIsOwner: true }, commandRuntime),
    ).rejects.toThrow('Plugin "impostor" cannot admit authenticated owner authority');

    registryBuilder.rollbackPluginGlobalSideEffects(owner.id, owner);
    await expect(retained(options, commandRuntime)).rejects.toThrow(
      'Plugin "discord" cannot admit authenticated owner authority',
    );
    registryBuilder.rollbackPluginGlobalSideEffects(untrusted.id, untrusted);
    await expect(retainedGuest(guestOptions, commandRuntime)).rejects.toThrow(
      'Plugin "impostor" cannot admit authenticated owner authority',
    );
    expect(command).toHaveBeenCalledTimes(3);
  });

  it("defers and preserves the exact active runtime across an inactive prepared load", async () => {
    const audit = createAudit();
    const gateway = createGateway(audit);
    const subagent = {} as PluginRuntime["subagent"];
    bindGatewayContextResolver(subagent, () => gateway);
    let channelReads = 0;
    const inbound = { buildContext: buildChannelInboundEventContext, dispatch: vi.fn() };
    const channel = { inbound, turn: inbound };
    const runtime = Object.defineProperty({ subagent } as PluginRuntime, "channel", {
      configurable: true,
      get: () => {
        channelReads += 1;
        return channel;
      },
    });
    const registryBuilder = createRegistry(runtime);
    const record = createPluginRecord({ id: "deferred-channel", origin: "bundled" });
    const api = registryBuilder.createApi(record, fullRegistration);

    api.registerChannel({ plugin: channelFixture("deferred-channel") });

    registryBuilder.registry.plugins.push(record);
    markPluginRegistryActive(registryBuilder.registry);
    const inactivePreparedRecord = createPluginRecord({
      id: record.id,
      origin: "bundled",
    });
    const inactivePreparedApi = registryBuilder.createApi(inactivePreparedRecord, fullRegistration);

    expect(channelReads).toBe(0);
    const registeredRuntime = registryBuilder.registry.channels[0]?.resolveChannelRuntime?.();
    expect(registeredRuntime).toBeDefined();
    expect(channelReads).toBe(1);
    expect(registeredRuntime!.turn).toBe(registeredRuntime!.inbound);
    expect(registeredRuntime!.turn.dispatch).toBe(inbound.dispatch);
    expect(inactivePreparedApi.runtime.channel.inbound.buildContext).toBe(
      buildChannelInboundEventContext,
    );
    expect(registryBuilder.registry.channels[0]?.resolveChannelRuntime?.()).toBe(registeredRuntime);

    const ingress = await resolveIngressForRuntime(registeredRuntime!, "person-a", {
      channelId: "deferred-channel",
    });
    expectIngress(
      registeredRuntime!.turn.buildContext,
      { ingress, channelId: "deferred-channel" },
      "present",
    );
  });

  it("does not mint for untrusted plugins, only the exact active bundled record", async () => {
    const audit = createAudit();
    const external = createRuntimeBuilder({ origin: "workspace", audit });
    const bundled = createRuntimeBuilder({ origin: "bundled", audit });
    const ingress = await bundled.resolveIngress("person-a");

    expect(inspect(external.buildContext(contextParams({ ingress })))).toMatchObject({
      ingressState: "unknown",
      invoker: { state: "unknown" },
    });
    expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
      ingressState: "present",
      invoker: { state: "present", kind: "person" },
      decisionCoverage: "enforced",
    });
  });

  it.each(["accepted", "mismatched", "builder failure"] as const)(
    "consumes the handoff after its first %s attempt",
    async (outcome) => {
      const bundled = bundledRuntime();
      const ingress = await bundled.resolveIngress("person-a");
      const input = contextParams({ ingress });
      if (outcome === "builder failure") {
        expect(() =>
          bundled.buildContext({
            ...input,
            finalize: () => {
              throw new Error("context failed");
            },
          }),
        ).toThrow("context failed");
      } else {
        if (outcome === "mismatched") {
          input.conversation = { kind: "group", id: "other-room" };
        }
        const state = outcome === "accepted" ? "present" : "unknown";
        expectIngressState(bundled.buildContext(input), state);
      }
      expectIngress(bundled.buildContext, { ingress }, "unknown");
    },
  );

  it.each<
    [
      string,
      Partial<Parameters<typeof contextParams>[0]>?,
      Parameters<typeof resolveIngressForRuntime>[2]?,
      ("event" | "accessor")?,
    ]
  >([
    ["agent", { route: route({ agentId: "other-agent" }) }],
    ["session", { route: route({ routeSessionKey: "agent:main:channel-owner:dm:other" }) }],
    ["message", { messageId: "message-2" }],
    ["event kind", { inboundEventKind: "room_event" }],
    ["conversation kind and id", { conversation: { kind: "group", id: "room-2" } }],
    [
      "thread",
      { conversation: group({ threadId: "thread-2" }) },
      { conversation: group({ threadId: "thread-1" }) },
    ],
    ["parent", { conversation: group({ parentId: "parent-2" }) }, { conversation: group() }],
    ["native channel", { conversation: { kind: "direct", id: "dm-1", nativeChannelId: "other" } }],
    ["routing account owner", { route: route({ accountId: "other-account" }) }],
    ["participant", { senderId: "person-b" }],
    [
      "omitted native conversation",
      undefined,
      { contextBinding: { ...ingressBinding, nativeChannelId: "native-dm-1" } },
    ],
    ["mutated event", undefined, undefined, "event"],
    ["accessor-bearing event", undefined, undefined, "accessor"],
  ])("rejects first-use %s substitution", async (_name, context, overrides, mutation) => {
    const bundled = bundledRuntime();
    const ingress = await bundled.resolveIngress("person-a", overrides);
    const getter = vi.fn(() => {
      throw new Error("must not run");
    });
    if (mutation === "event") {
      ingress.state.event.kind = "reaction";
    } else if (mutation === "accessor") {
      Object.defineProperty(ingress.state, "event", { configurable: true, get: getter });
    }
    expectIngress(bundled.buildContext, { ingress, ...context }, "unknown");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ["same channel across Gateways", "shared-owner", "shared-owner", "person-a", true],
    ["different registered records", "alpha-owner", "beta-owner", "person-b", false],
  ] as const)(
    "isolates %s and rejects cross-record reuse",
    async (_name, firstId, secondId, participant, separateAudit) => {
      const firstAudit = createAudit();
      const secondAudit = separateAudit ? createAudit() : firstAudit;
      const firstGateway = createGateway(firstAudit);
      const secondGateway = createGateway(secondAudit);
      const first = createRuntimeBuilder({
        origin: "bundled",
        id: firstId,
        gatewayContextResolver: () => firstGateway,
      });
      const firstIngress = await first.resolveIngress("person-a", { channelId: firstId });
      const second = createRuntimeBuilder({
        origin: "bundled",
        id: secondId,
        gatewayContextResolver: () => secondGateway,
      });
      try {
        const firstContext = first.buildContext(
          contextParams({ ingress: firstIngress, channelId: firstId }),
        );
        expectIngressState(firstContext, "present");
        expect(readChannelContextGatewayContextResolver(firstContext)?.()).toBe(firstGateway);
        const secondIngress = await second.resolveIngress(participant, { channelId: secondId });
        const secondContext = second.buildContext(
          contextParams({ ingress: secondIngress, channelId: secondId, senderId: participant }),
        );
        expectIngressState(secondContext, "present");
        expect(readChannelContextGatewayContextResolver(secondContext)?.()).toBe(secondGateway);
        const foreignIngress = await first.resolveIngress("person-a", { channelId: firstId });
        expectIngress(
          second.buildContext,
          { ingress: foreignIngress, channelId: secondId },
          "unknown",
        );
        if (separateAudit) {
          secondAudit.close();
          markPluginRegistryRetired(second.registryBuilder.registry);
          const survivingIngress = await first.resolveIngress("person-a", { channelId: firstId });
          expectIngress(
            first.buildContext,
            { ingress: survivingIngress, channelId: firstId },
            "present",
          );
        }
      } finally {
        markPluginRegistryRetired(first.registryBuilder.registry);
        markPluginRegistryRetired(second.registryBuilder.registry);
      }
    },
  );

  it("preserves a live channel owner but never revives its retired instance", async () => {
    const audit = createAudit();
    const bundled = bundledRuntime(audit);
    markPluginRegistryActive(bundled.registryBuilder.registry);
    const liveIngress = await bundled.resolveIngress("person-a");
    expectIngress(bundled.buildContext, { ingress: liveIngress }, "present");
    const ingress = await bundled.resolveIngress("person-a");
    markPluginRegistryRetired(bundled.registryBuilder.registry);
    markPluginRegistryActive(bundled.registryBuilder.registry);

    expectIngress(bundled.buildContext, { ingress }, "unknown");
    const reactivatedBuildContext = bundled.resolveBuildContext();
    const reactivatedIngress = await bundled.resolveIngress("person-a");
    expectIngress(reactivatedBuildContext, { ingress: reactivatedIngress }, "unknown");
    const replacement = bundledRuntime(audit);
    const replacementIngress = await replacement.resolveIngress("person-a");
    expectIngress(replacement.buildContext, { ingress: replacementIngress }, "present");
  });

  it("degrades stale, replaced, and rollback-owned closures to unknown", async () => {
    const audit = createAudit();
    const stale = bundledRuntime(audit);
    const replaced = bundledRuntime(audit);
    const rollback = bundledRuntime(audit);
    const staleIngress = await stale.resolveIngress("person-a");
    const replacedIngress = await replaced.resolveIngress("person-a");
    const rollbackIngress = await rollback.resolveIngress("person-a");
    const liveIngress = await rollback.resolveIngress("person-a");

    expectIngress(rollback.buildContext, { ingress: liveIngress }, "present");

    markPluginRegistryRetired(stale.registryBuilder.registry);
    const replacementRecord = createPluginRecord({ id: replaced.record.id, origin: "bundled" });
    const replacementApi = replaced.registryBuilder.createApi(replacementRecord, fullRegistration);
    const registration = replaced.registryBuilder.registry.channels[0]!;
    withPluginRegistryPreparationScope(replaced.registryBuilder.registry, () => {
      replacementApi.registerChannel({ plugin: registration.plugin });
    });
    const previousIndex = replaced.registryBuilder.registry.plugins.indexOf(replaced.record);
    replaced.registryBuilder.registry.plugins.splice(previousIndex, 1, replacementRecord);
    const replacementRuntime = registration.resolveChannelRuntime!();
    const replacementIngress = await resolveIngressForRuntime(replacementRuntime, "person-a");
    expectIngress(
      replacementRuntime.inbound.buildContext,
      { ingress: replacementIngress },
      "present",
    );
    rollback.registryBuilder.rollbackPluginGlobalSideEffects(rollback.record.id, rollback.record);

    for (const [channel, ingress] of [
      [stale, staleIngress],
      [replaced, replacedIngress],
      [rollback, rollbackIngress],
    ] as const) {
      expectIngress(channel.buildContext, { ingress }, "unknown");
    }
  });

  it("binds aggregates to their final source and rejects structural or mixed participants", async () => {
    const audit = createAudit();
    const bundled = bundledRuntime(audit);
    const first = await bundled.resolveIngress("person-a");
    const same = await bundled.resolveIngress("person-a", {
      contextBinding: { ...ingressBinding, messageId: "message-2" },
    });
    const mixed = await bundled.resolveIngress("person-b");

    expectIngress(bundled.buildContext, { ingress: { ...first } }, "unknown");
    expectIngress(
      bundled.buildContext,
      { ingress: [first, same], messageId: "message-2" },
      "present",
    );
    expectIngress(bundled.buildContext, { ingress: [first, mixed] }, "unknown");
  });
});

describe("plugin runtime hook dispatch ownership", () => {
  it.each([
    { origin: "bundled" as const, trustedOfficialInstall: undefined },
    { origin: "global" as const, trustedOfficialInstall: true },
  ])("binds $origin hook dispatch to its host-owned plugin identity", async (ownership) => {
    const hookTurn = {
      name: "Inbox watcher",
      agentId: "mail",
      sessionKey: "hook:imap:account:1",
      message: "Summarize the incoming email.",
      externalContentSource: "email",
      deliver: false,
    } satisfies Parameters<PluginRuntime["hooks"]["dispatchHookAgentTurn"]>[0];
    let observedPluginId: string | undefined;
    const dispatchHookAgentTurn = vi.fn(async () => {
      observedPluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
      return { ok: true as const, runId: "hook-run" };
    });
    const builder = createRegistry(
      createLazyPluginRuntime({ runtimeOptions: { hooks: { dispatchHookAgentTurn } } }),
    );
    const record = createPluginRecord({ id: "trusted-mail", ...ownership });
    const api = builder.createApi(record, { config: {} });
    builder.registry.plugins.push(record);

    await expect(api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).resolves.toEqual({
      ok: true,
      runId: "hook-run",
    });
    expect(observedPluginId).toBe("trusted-mail");
    expect(dispatchHookAgentTurn).toHaveBeenCalledWith(hookTurn);
  });
});
