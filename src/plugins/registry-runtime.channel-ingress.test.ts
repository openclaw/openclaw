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
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  resolveStableChannelMessageIngress,
} from "../plugin-sdk/channel-ingress-runtime.js";
import { recordAcceptedSessionParticipantInput } from "../sessions/session-participant-input-recording.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
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
import { createTestPluginRegistry as createRegistry } from "./registry-runtime.test-helpers.js";
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
type ContextParams = Parameters<typeof contextParams>[0];
type InboundContext = ReturnType<typeof buildChannelInboundEventContext>;

function expectIngressState(context: object, state: "present" | "unknown") {
  expect(inspect(context)).toMatchObject({ ingressState: state, invoker: { state } });
}
function expectIngress(
  source:
    | typeof buildChannelInboundEventContext
    | { buildContext: typeof buildChannelInboundEventContext },
  ingress: ContextParams["ingress"],
  state: "present" | "unknown",
  params: Omit<ContextParams, "ingress"> = {},
) {
  const build = typeof source === "function" ? source : source.buildContext;
  expectIngressState(build(contextParams({ ingress, ...params })), state);
}
const audits = new Set<ChannelAdmissionAudit>();
const cleanups: Array<() => void | Promise<void>> = [];
const fullRegistration = { config: {}, registrationMode: "full" as const };
const sessionKey = "agent:main:channel-owner:dm:dm-1";
const ingressBinding = {
  agentId: "main",
  sessionKey,
  messageId: "message-1",
  inboundEventKind: "user_request" as const,
};
function route(overrides: Partial<ContextParams["route"]> = {}) {
  return { agentId: "main", routeSessionKey: sessionKey, ...overrides };
}
function group(overrides: Partial<ContextParams["conversation"]> = {}) {
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
function createGateway(audit: ChannelAdmissionAudit) {
  return { channelAdmissionAudit: audit, getRuntimeConfig: () => ({}) } as GatewayRequestContext;
}
function scopedGateway(id: string, audit: ChannelAdmissionAudit, origin: "bundled" | "global") {
  const gateway = createGateway(audit);
  const gatewayContextResolver = () => gateway;
  const channel = createRuntimeBuilder({
    origin,
    trustedOfficialInstall: origin === "global",
    id,
    gatewayContextResolver,
  });
  cleanups.push(() => markPluginRegistryRetired(channel.registryBuilder.registry));
  const buildContext = channel.api.runtime.channel.inbound.buildContext;
  return {
    ...channel,
    gateway,
    gatewayContextResolver,
    receive: async (senderId = "person-a") =>
      buildContext(
        contextParams({
          ingress: await channel.resolveIngress(senderId, { channelId: id }),
          channelId: id,
          senderId,
        }),
      ),
  };
}

function createAudit() {
  const audit = createChannelAdmissionAudit({ enabled: true });
  audits.add(audit);
  return audit;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  for (const audit of audits) {
    audit.close();
  }
  audits.clear();
});

it("keeps adopted channel operations usable after their captured registry is collected", async () => {
  class RetainedService {
    id = "retired-channel-scope";
    start() {}
  }
  const registryBuilder = createRegistry(createPluginRuntime());
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
      ...createChannelTestPluginBase({ id: record.id }),
      outbound: { deliveryMode: "direct" },
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
  try {
    await setImmediate();
    expect(queryObjects(RetainedService)).toBe(0);
    for (const readChannel of [() => capturedChannel, () => api.runtime.channel]) {
      await resource.runInAsyncScope(async () => {
        const channel = readChannel();
        expect(await channel.outbound.loadAdapter(record.id)).toBe(
          current.channels[0]?.plugin.outbound,
        );
        for (const method of [
          "setIdleTimeoutBySessionKey",
          "setIdleTimeoutBySessionKeyAsync",
        ] as const) {
          expect(await channel.threadBindings[method]({ ...input, idleTimeoutMs: 10 })).toEqual([
            binding,
          ]);
        }
        for (const method of ["setMaxAgeBySessionKey", "setMaxAgeBySessionKeyAsync"] as const) {
          expect(await channel.threadBindings[method]({ ...input, maxAgeMs: 20 })).toEqual([
            binding,
          ]);
        }
      });
    }
    for (const [name, method] of Object.entries(bindings)) {
      expect(method).toHaveBeenCalledTimes(2);
      expect(method).toHaveBeenLastCalledWith({
        targetSessionKey: input.targetSessionKey,
        accountId: undefined,
        ...(name.includes("Idle") ? { idleTimeoutMs: 10 } : { maxAgeMs: 20 }),
      });
    }
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      expect(await capturedChannel.outbound.loadAdapter(record.id)).toBeUndefined();
    });
  } finally {
    resource.emitDestroy();
    markPluginRegistryRetired(current);
    await instance.dispose();
  }
});

type LegacyIngressMethod = "direct" | "stable" | "factory";

function createLegacyReceiver(
  params: {
    audit?: ChannelAdmissionAudit;
    trusted?: boolean;
    readStoreAllowFrom?: () => Promise<string[]>;
  } = {},
) {
  const audit = params.audit ?? createAudit();
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
    audit,
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
  const dispose = async () => {
    markPluginRegistryRetired(channel.registryBuilder.registry);
    await channel.instance!.dispose();
  };
  cleanups.push(dispose);
  return {
    ...channel,
    audit,
    resolvers,
    receive: async (resolve: () => Promise<ResolvedChannelMessageIngress>) => {
      receiveIngress = resolve;
      const startAccount =
        channel.registryBuilder.registry.channels[0]!.plugin.gateway!.startAccount!;
      return (await startAccount({} as never)) as InboundContext;
    },
    dispose,
  };
}

describe("bundled channel ingress runtime ownership", () => {
  it("never binds a registration-time factory to another live instance of the same channel", async () => {
    const first = createLegacyReceiver();
    const second = createLegacyReceiver();
    expectProvenance(await second.receive(first.resolvers.factory));
    expectProvenance(await first.receive(first.resolvers.factory), first.audit);
    expectProvenance(await second.receive(second.resolvers.factory), second.audit);
    await first.dispose();
    expectProvenance(await second.receive(first.resolvers.factory));
  });

  it("drops released-helper provenance when its owner retires during policy resolution", async () => {
    const entered = createDeferredCore();
    const allowFrom = createDeferredCore<string[]>();
    cleanups.unshift(() => allowFrom.resolve([]));
    const channel = createLegacyReceiver({
      readStoreAllowFrom: () => {
        entered.resolve();
        return allowFrom.promise;
      },
    });
    const pending = channel.receive(channel.resolvers.direct);
    await entered.promise;
    markPluginRegistryRetired(channel.registryBuilder.registry);
    allowFrom.resolve([]);
    expectProvenance(await pending);
  });

  it("retains released helpers when the exact channel instance moves to a new registry", async () => {
    const channel = createLegacyReceiver();
    const next = createEmptyPluginRegistry();
    cleanups.unshift(() => markPluginRegistryRetired(next));
    next.plugins.push(channel.record);
    next.channels.push(...channel.registryBuilder.registry.channels);
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
        channel.audit,
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
    expectProvenance(await channel.receive(channel.resolvers.factory));
  });

  it("keeps unqualified released helpers policy-only even beside a trusted channel", async () => {
    const trusted = createLegacyReceiver();
    const untrusted = createLegacyReceiver({ audit: trusted.audit, trusted: false });
    for (const method of ["direct", "stable", "factory"] as const) {
      const outside = await trusted.resolvers[method]();
      expect(outside.ingress.admission).toBe("dispatch");
      expectProvenance(trusted.buildContext(contextParams({ ingress: outside })));
      const external = await untrusted.receive(untrusted.resolvers[method]);
      expect(readChannelContextGatewayContextResolver(external)).toBeUndefined();
      recordParticipant.mockClear();
      recordInput(external);
      expect(recordParticipant).not.toHaveBeenCalled();
    }
  });

  it("binds authenticated owner turns to the exact live trusted channel plugin", async () => {
    const runtime = createPluginRuntime();
    const command = vi.fn(async () => ({ payloads: [] }));
    Object.defineProperty(runtime.agent, "runCommandFromIngress", {
      configurable: true,
      value: command,
    });
    const registryBuilder = createRegistry(runtime);
    const addPlugin = (id: string, origin: "bundled" | "workspace", channelId?: string) => {
      const record = createPluginRecord({ id, origin });
      const api = registryBuilder.createApi(record, { config: {} });
      registryBuilder.registry.plugins.push(record);
      if (channelId) {
        registryBuilder.registry.channels.push({
          pluginId: id,
          plugin: { id: channelId },
          source: record.source,
        } as never);
      }
      return { record, api };
    };
    const { record: owner, api: ownerApi } = addPlugin("discord", "bundled", "discord");
    const { api: foreignApi } = addPlugin("foreign", "bundled");
    const { record: untrusted, api: untrustedApi } = addPlugin(
      "impostor",
      "workspace",
      "community",
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

    api.registerChannel({ plugin: createChannelTestPluginBase({ id: record.id }) });

    registryBuilder.registry.plugins.push(record);
    markPluginRegistryActive(registryBuilder.registry);
    const inactivePreparedApi = registryBuilder.createApi(
      createPluginRecord({ id: record.id, origin: "bundled" }),
      fullRegistration,
    );

    expect(channelReads).toBe(0);
    const registeredRuntime = registryBuilder.registry.channels[0]?.resolveChannelRuntime?.();
    expect(channelReads).toBe(1);
    expect(inactivePreparedApi.runtime.channel.inbound.buildContext).toBe(
      buildChannelInboundEventContext,
    );

    const ingress = await resolveIngressForRuntime(registeredRuntime!, "person-a", {
      channelId: "deferred-channel",
    });
    expectIngress(registeredRuntime!.turn, ingress, "present", { channelId: "deferred-channel" });
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
      expectIngress(bundled, ingress, "unknown");
    },
  );

  it.each<
    [
      string,
      Partial<ContextParams>?,
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
    expectIngress(bundled, ingress, "unknown", context);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ["bundled", "shared-owner", "shared-owner"],
    ["global", "shared-owner", "shared-owner"],
    ["bundled", "alpha-owner", "beta-owner"],
  ] as const)(
    "isolates %s Gateways for %s / %s and rejects cross-record reuse",
    async (origin, firstId, secondId) => {
      const firstAudit = createAudit();
      const separateAudit = firstId === secondId;
      const secondAudit = separateAudit ? createAudit() : firstAudit;
      const first = scopedGateway(firstId, firstAudit, origin);
      const second = scopedGateway(secondId, secondAudit, origin);
      const firstContext = await first.receive();
      expectIngressState(firstContext, "present");
      expect(readChannelContextGatewayContextResolver(firstContext)?.()).toBe(first.gateway);
      const secondContext = await second.receive("person-b");
      expect(inspect(secondContext)).toMatchObject({
        ingressState: "present",
        invoker: { state: "present", kind: "person" },
        decisionCoverage: "enforced",
      });
      const retainedResolver = readChannelContextGatewayContextResolver(secondContext);
      expect(retainedResolver?.()).toBe(second.gateway);
      expect(hasGatewayContextOwner(retainedResolver!, second.gatewayContextResolver)).toBe(true);
      const foreignIngress = await first.resolveIngress("person-a", { channelId: firstId });
      expectIngress(second, foreignIngress, "unknown", { channelId: secondId });
      const external = createRuntimeBuilder({
        origin: "workspace",
        id: firstId,
        audit: firstAudit,
      });
      expectIngress(
        external,
        await first.resolveIngress("person-a", { channelId: firstId }),
        "unknown",
        { channelId: firstId },
      );
      markPluginRegistryRetired(second.registryBuilder.registry);
      expect(retainedResolver?.()).toBeUndefined();
      expectProvenance(await second.receive("person-b"));
      if (separateAudit) {
        secondAudit.close();
      }
      expectProvenance(await first.receive(), firstAudit);
    },
  );

  it("preserves a live channel owner but never revives its retired instance", async () => {
    const audit = createAudit();
    const bundled = bundledRuntime(audit);
    markPluginRegistryActive(bundled.registryBuilder.registry);
    const liveIngress = await bundled.resolveIngress("person-a");
    expectIngress(bundled, liveIngress, "present");
    const ingress = await bundled.resolveIngress("person-a");
    markPluginRegistryRetired(bundled.registryBuilder.registry);
    markPluginRegistryActive(bundled.registryBuilder.registry);

    expectIngress(bundled, ingress, "unknown");
    const reactivatedBuildContext = bundled.resolveBuildContext();
    const reactivatedIngress = await bundled.resolveIngress("person-a");
    expectIngress(reactivatedBuildContext, reactivatedIngress, "unknown");
    const replacement = bundledRuntime(audit);
    const replacementIngress = await replacement.resolveIngress("person-a");
    expectIngress(replacement, replacementIngress, "present");
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

    expectIngress(rollback, liveIngress, "present");

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
    expectIngress(replacementRuntime.inbound, replacementIngress, "present");
    rollback.registryBuilder.rollbackPluginGlobalSideEffects(rollback.record.id, rollback.record);

    for (const [channel, ingress] of [
      [stale, staleIngress],
      [replaced, replacedIngress],
      [rollback, rollbackIngress],
    ] as const) {
      expectIngress(channel, ingress, "unknown");
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

    expectIngress(bundled, { ...first }, "unknown");
    expectIngress(bundled, [first, same], "present", { messageId: "message-2" });
    expectIngress(bundled, [first, mixed], "unknown");
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
