import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import {
  createChannelAdmissionAudit,
  readChannelContextGatewayContextResolver,
  type ChannelAdmissionAudit,
} from "../channels/message-access/admission-evidence.js";
import type { ResolvedChannelMessageIngress } from "../channels/message-access/runtime-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  resolveStableChannelMessageIngress,
} from "../plugin-sdk/channel-ingress-runtime.js";
import { recordAcceptedSessionParticipantInput } from "../sessions/session-participant-input-recording.js";
import { createDeferredCore } from "../shared/deferred.js";
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
  hasGatewayContextOwner,
} from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: recordParticipant,
}));

const audits = new Set<ChannelAdmissionAudit>();
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
    contextBinding: {
      agentId: "main",
      sessionKey: "agent:main:channel-owner:dm:dm-1",
      messageId: "message-1",
      inboundEventKind: "user_request" as const,
    },
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
  it.each(["direct", "stable", "factory"] as const)(
    "preserves the released %s helper through a trusted external channel callback",
    async (method) => {
      const audit = createAudit();
      const channel = createLegacyReceiver({ audit });
      try {
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
        recordAcceptedSessionParticipantInput(context, {
          agentId: "main",
          sessionKey: "agent:main:channel-owner:dm:dm-1",
          storePath: "/unused",
        });
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
      } finally {
        await channel.dispose();
        audit.close();
      }
    },
  );

  it("never binds a registration-time factory to another live instance of the same channel", async () => {
    const firstAudit = createAudit();
    const secondAudit = createAudit();
    const first = createLegacyReceiver({ audit: firstAudit });
    const second = createLegacyReceiver({ audit: secondAudit });
    try {
      const foreign = await second.receive(first.resolvers.factory);
      expect(inspect(foreign)).toMatchObject({ ingressState: "unknown" });
      expect(readChannelContextGatewayContextResolver(foreign)).toBeUndefined();
      const original = await first.receive(first.resolvers.factory);
      expect(inspect(original)).toMatchObject({ ingressState: "present" });
      expect(readChannelContextGatewayContextResolver(original)?.()?.channelAdmissionAudit).toBe(
        firstAudit,
      );
      const independent = await second.receive(second.resolvers.factory);
      expect(inspect(independent)).toMatchObject({ ingressState: "present" });
      expect(readChannelContextGatewayContextResolver(independent)?.()?.channelAdmissionAudit).toBe(
        secondAudit,
      );
      await first.dispose();
      const retired = await second.receive(first.resolvers.factory);
      expect(inspect(retired)).toMatchObject({ ingressState: "unknown" });
      expect(readChannelContextGatewayContextResolver(retired)).toBeUndefined();
    } finally {
      await first.dispose();
      await second.dispose();
      firstAudit.close();
      secondAudit.close();
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
      expect(inspect(context)).toMatchObject({ ingressState: "unknown" });
      expect(readChannelContextGatewayContextResolver(context)).toBeUndefined();
    } finally {
      allowFrom.resolve([]);
      await channel.dispose();
      audit.close();
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
        const context = await channel.receive(channel.resolvers[method]);
        expect(inspect(context)).toMatchObject({ ingressState: "present" });
        expect(readChannelContextGatewayContextResolver(context)?.()?.channelAdmissionAudit).toBe(
          audit,
        );
      }
      next.channels.splice(0);
      const removed = await channel.receive(channel.resolvers.factory);
      expect(inspect(removed)).toMatchObject({ ingressState: "unknown" });
      expect(readChannelContextGatewayContextResolver(removed)).toBeUndefined();
    } finally {
      markPluginRegistryRetired(next);
      await channel.dispose();
      audit.close();
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
        expect(inspect(context)).toMatchObject({ ingressState: "unknown" });
        expect(readChannelContextGatewayContextResolver(context)).toBeUndefined();
        const external = await untrusted.receive(untrusted.resolvers[method]);
        expect(readChannelContextGatewayContextResolver(external)).toBeUndefined();
        recordParticipant.mockClear();
        recordAcceptedSessionParticipantInput(external, {
          agentId: "main",
          sessionKey: "agent:main:channel-owner:dm:dm-1",
          storePath: "/unused",
        });
        expect(recordParticipant).not.toHaveBeenCalled();
      }
    } finally {
      await trusted.dispose();
      await untrusted.dispose();
      audit.close();
    }
  });

  it.each(["bundled", "global", "config"] as const)(
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
    const registryBuilder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime,
      activateGlobalSideEffects: false,
    });
    const owner = createPluginRecord({ id: "discord", origin: "bundled" });
    const foreign = createPluginRecord({ id: "foreign", origin: "bundled" });
    const untrusted = createPluginRecord({ id: "impostor", origin: "workspace" });
    const ownerApi = registryBuilder.createApi(owner, { config: {} as OpenClawConfig });
    const foreignApi = registryBuilder.createApi(foreign, { config: {} as OpenClawConfig });
    const untrustedApi = registryBuilder.createApi(untrusted, { config: {} as OpenClawConfig });
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
    expect(ownerClaimReads).toBe(1);
    expect(channelReads).toBe(1);
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
    const gateway = {
      channelAdmissionAudit: audit,
      getRuntimeConfig: () => ({}),
    } as GatewayRequestContext;
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
    const registryBuilder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime,
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "deferred-channel", origin: "bundled" });
    const api = registryBuilder.createApi(record, {
      config: {} as OpenClawConfig,
      registrationMode: "full",
    });

    api.registerChannel({
      plugin: {
        id: "deferred-channel",
        meta: {
          id: "deferred-channel",
          label: "Deferred Channel",
          selectionLabel: "Deferred Channel",
          docsPath: "/channels/deferred-channel",
          blurb: "test channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });

    registryBuilder.registry.plugins.push(record);
    markPluginRegistryActive(registryBuilder.registry);
    const inactivePreparedRecord = createPluginRecord({
      id: record.id,
      origin: "bundled",
    });
    const inactivePreparedApi = registryBuilder.createApi(inactivePreparedRecord, {
      config: {} as OpenClawConfig,
      registrationMode: "full",
    });

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
    expect(
      inspect(
        registeredRuntime!.turn.buildContext(
          contextParams({ ingress, channelId: "deferred-channel" }),
        ),
      ),
    ).toMatchObject({ ingressState: "present", invoker: { state: "present" } });
  });

  it.each(["workspace", "global"] as const)(
    "does not mint for %s plugins, only the exact active bundled record",
    async (origin) => {
      const audit = createAudit();
      const external = createRuntimeBuilder({ origin, audit });
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
    },
  );

  it.each(["accepted", "mismatched", "builder failure"] as const)(
    "consumes the handoff after its first %s attempt",
    async (outcome) => {
      const bundled = createRuntimeBuilder({ origin: "bundled", audit: createAudit() });
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
        expect(inspect(bundled.buildContext(input))).toMatchObject({
          ingressState: state,
          invoker: { state },
        });
      }
      expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    },
  );

  it.each<{
    name: string;
    ingress?: Parameters<typeof resolveIngressForRuntime>[2];
    context?: Partial<Parameters<typeof contextParams>[0]>;
    mutation?: "event" | "accessor";
  }>([
    {
      name: "agent",
      context: {
        route: { agentId: "other-agent", routeSessionKey: "agent:main:channel-owner:dm:dm-1" },
      },
    },
    {
      name: "session",
      context: { route: { agentId: "main", routeSessionKey: "agent:main:channel-owner:dm:other" } },
    },
    { name: "message", context: { messageId: "message-2" } },
    { name: "event kind", context: { inboundEventKind: "room_event" } },
    {
      name: "conversation kind and id",
      context: { conversation: { kind: "group", id: "room-2" } },
    },
    {
      name: "thread",
      ingress: {
        conversation: { kind: "group", id: "room-1", parentId: "parent-1", threadId: "thread-1" },
      },
      context: {
        conversation: { kind: "group", id: "room-1", parentId: "parent-1", threadId: "thread-2" },
      },
    },
    {
      name: "parent",
      ingress: { conversation: { kind: "group", id: "room-1", parentId: "parent-1" } },
      context: { conversation: { kind: "group", id: "room-1", parentId: "parent-2" } },
    },
    {
      name: "native channel",
      context: { conversation: { kind: "direct", id: "dm-1", nativeChannelId: "other" } },
    },
    {
      name: "routing account owner",
      context: {
        route: {
          agentId: "main",
          accountId: "other-account",
          routeSessionKey: "agent:main:channel-owner:dm:dm-1",
        },
      },
    },
    { name: "participant", context: { senderId: "person-b" } },
    { name: "participant whitespace", context: { senderId: " person-a " } },
    {
      name: "omitted native conversation",
      ingress: {
        contextBinding: {
          agentId: "main",
          sessionKey: "agent:main:channel-owner:dm:dm-1",
          messageId: "message-1",
          nativeChannelId: "native-dm-1",
          inboundEventKind: "user_request",
        },
      },
    },
    { name: "mutated event", mutation: "event" },
    { name: "accessor-bearing event", mutation: "accessor" },
  ])("rejects first-use $name substitution", async ({ ingress: overrides, context, mutation }) => {
    const bundled = createRuntimeBuilder({ origin: "bundled", audit: createAudit() });
    const ingress = await bundled.resolveIngress("person-a", overrides);
    const getter = vi.fn(() => {
      throw new Error("must not run");
    });
    if (mutation === "event") {
      ingress.state.event.kind = "reaction";
    } else if (mutation === "accessor") {
      Object.defineProperty(ingress.state, "event", { configurable: true, get: getter });
    }
    expect(inspect(bundled.buildContext(contextParams({ ingress, ...context })))).toMatchObject({
      ingressState: "unknown",
      invoker: { state: "unknown" },
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "same channel across Gateways",
      firstId: "shared-owner",
      secondId: "shared-owner",
      participant: "person-a",
      separateAudit: true,
    },
    {
      name: "different registered records",
      firstId: "alpha-owner",
      secondId: "beta-owner",
      participant: "person-b",
      separateAudit: false,
    },
  ])(
    "isolates $name and rejects cross-record reuse",
    async ({ firstId, secondId, participant, separateAudit }) => {
      const firstAudit = createAudit();
      const secondAudit = separateAudit ? createAudit() : firstAudit;
      const firstGateway = {
        channelAdmissionAudit: firstAudit,
        getRuntimeConfig: () => ({}),
      } as GatewayRequestContext;
      const secondGateway = {
        channelAdmissionAudit: secondAudit,
        getRuntimeConfig: () => ({}),
      } as GatewayRequestContext;
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
        expect(inspect(firstContext)).toMatchObject({
          ingressState: "present",
          invoker: { state: "present" },
        });
        expect(readChannelContextGatewayContextResolver(firstContext)?.()).toBe(firstGateway);
        const secondIngress = await second.resolveIngress(participant, { channelId: secondId });
        const secondContext = second.buildContext(
          contextParams({ ingress: secondIngress, channelId: secondId, senderId: participant }),
        );
        expect(inspect(secondContext)).toMatchObject({
          ingressState: "present",
          invoker: { state: "present" },
        });
        expect(readChannelContextGatewayContextResolver(secondContext)?.()).toBe(secondGateway);
        const foreignIngress = await first.resolveIngress("person-a", { channelId: firstId });
        expect(
          inspect(
            second.buildContext(contextParams({ ingress: foreignIngress, channelId: secondId })),
          ),
        ).toMatchObject({ ingressState: "unknown", invoker: { state: "unknown" } });
        if (separateAudit) {
          secondAudit.close();
          markPluginRegistryRetired(second.registryBuilder.registry);
          const survivingIngress = await first.resolveIngress("person-a", { channelId: firstId });
          expect(
            inspect(
              first.buildContext(contextParams({ ingress: survivingIngress, channelId: firstId })),
            ),
          ).toMatchObject({ ingressState: "present", invoker: { state: "present" } });
        }
      } finally {
        markPluginRegistryRetired(first.registryBuilder.registry);
        markPluginRegistryRetired(second.registryBuilder.registry);
      }
    },
  );

  it("preserves a live channel owner but never revives its retired instance", async () => {
    const audit = createAudit();
    const bundled = createRuntimeBuilder({ origin: "bundled", audit });
    markPluginRegistryActive(bundled.registryBuilder.registry);
    const liveIngress = await bundled.resolveIngress("person-a");
    expect(inspect(bundled.buildContext(contextParams({ ingress: liveIngress })))).toMatchObject({
      ingressState: "present",
      invoker: { state: "present" },
    });
    const ingress = await bundled.resolveIngress("person-a");
    markPluginRegistryRetired(bundled.registryBuilder.registry);
    markPluginRegistryActive(bundled.registryBuilder.registry);

    expect(inspect(bundled.buildContext(contextParams({ ingress })))).toMatchObject({
      ingressState: "unknown",
      invoker: { state: "unknown" },
    });
    const reactivatedBuildContext = bundled.resolveBuildContext();
    const reactivatedIngress = await bundled.resolveIngress("person-a");
    expect(
      inspect(reactivatedBuildContext(contextParams({ ingress: reactivatedIngress }))),
    ).toMatchObject({
      ingressState: "unknown",
      invoker: { state: "unknown" },
    });
    const replacement = createRuntimeBuilder({ origin: "bundled", audit });
    const replacementIngress = await replacement.resolveIngress("person-a");
    expect(
      inspect(replacement.buildContext(contextParams({ ingress: replacementIngress }))),
    ).toMatchObject({
      ingressState: "present",
      invoker: { state: "present" },
    });
  });

  it("degrades stale, replaced, and rollback-owned closures to unknown", async () => {
    const audit = createAudit();
    const stale = createRuntimeBuilder({ origin: "bundled", audit });
    const replaced = createRuntimeBuilder({ origin: "bundled", audit });
    const rollback = createRuntimeBuilder({ origin: "bundled", audit });
    const staleIngress = await stale.resolveIngress("person-a");
    const replacedIngress = await replaced.resolveIngress("person-a");
    const rollbackIngress = await rollback.resolveIngress("person-a");
    const liveIngress = await rollback.resolveIngress("person-a");

    expect(inspect(rollback.buildContext(contextParams({ ingress: liveIngress })))).toMatchObject({
      ingressState: "present",
    });

    markPluginRegistryRetired(stale.registryBuilder.registry);
    const replacementRecord = createPluginRecord({ id: replaced.record.id, origin: "bundled" });
    const replacementApi = replaced.registryBuilder.createApi(replacementRecord, {
      config: {} as OpenClawConfig,
      registrationMode: "full",
    });
    const registration = replaced.registryBuilder.registry.channels[0]!;
    withPluginRegistryPreparationScope(replaced.registryBuilder.registry, () => {
      replacementApi.registerChannel({ plugin: registration.plugin });
    });
    const previousIndex = replaced.registryBuilder.registry.plugins.indexOf(replaced.record);
    replaced.registryBuilder.registry.plugins.splice(previousIndex, 1, replacementRecord);
    const replacementRuntime = registration.resolveChannelRuntime!();
    const replacementIngress = await resolveIngressForRuntime(replacementRuntime, "person-a");
    expect(
      inspect(
        replacementRuntime.inbound.buildContext(contextParams({ ingress: replacementIngress })),
      ),
    ).toMatchObject({ ingressState: "present" });
    rollback.registryBuilder.rollbackPluginGlobalSideEffects(rollback.record.id, rollback.record);

    for (const [channel, ingress] of [
      [stale, staleIngress],
      [replaced, replacedIngress],
      [rollback, rollbackIngress],
    ] as const) {
      expect(inspect(channel.buildContext(contextParams({ ingress })))).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    }
  });

  it("binds aggregates to their final source and rejects structural or mixed participants", async () => {
    const audit = createAudit();
    const bundled = createRuntimeBuilder({ origin: "bundled", audit });
    const first = await bundled.resolveIngress("person-a");
    const same = await bundled.resolveIngress("person-a", {
      contextBinding: {
        agentId: "main",
        sessionKey: "agent:main:channel-owner:dm:dm-1",
        messageId: "message-2",
        inboundEventKind: "user_request",
      },
    });
    const mixed = await bundled.resolveIngress("person-b");

    expect(inspect(bundled.buildContext(contextParams({ ingress: { ...first } })))).toMatchObject({
      ingressState: "unknown",
    });
    expect(
      inspect(
        bundled.buildContext(contextParams({ ingress: [first, same], messageId: "message-2" })),
      ),
    ).toMatchObject({
      ingressState: "present",
      invoker: { state: "present" },
    });
    expect(inspect(bundled.buildContext(contextParams({ ingress: [first, mixed] })))).toMatchObject(
      {
        ingressState: "unknown",
        invoker: { state: "unknown" },
      },
    );
  });
});
