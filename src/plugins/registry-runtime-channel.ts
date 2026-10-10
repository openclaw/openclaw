import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import { createHostChannelIngressRuntime } from "../channels/message-access/runtime.js";
import { isPluginRecordActive, revokePluginRecord } from "./registry-lifecycle.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import {
  bindGatewayContextResolver,
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

type BuildContextParams = Parameters<PluginRuntime["channel"]["inbound"]["buildContext"]>[0];
type BuiltContext = ReturnType<PluginRuntime["channel"]["inbound"]["buildContext"]>;

/** Channel admission belongs to the exact registered record and closes on replacement. */
export function createRegisteredChannelRuntimeResolver(
  state: PluginRegistryState,
  readChannel: (record: PluginRecord) => PluginRuntime["channel"],
) {
  const { registry, registryParams } = state;
  const registeredChannelRuntime = new WeakMap<PluginRecord, PluginRuntime["channel"]>();
  const registeredRuntimeRecordById = new Map<string, PluginRecord>();
  const registeredAdmissionOwnerByRecord = new WeakMap<
    PluginRecord,
    { isLive: () => boolean; dispose: () => void }
  >();

  const resolveRecordChannelRuntime = (record: PluginRecord): PluginRuntime["channel"] => {
    const cached = registeredChannelRuntime.get(record);
    const cachedOwner = registeredAdmissionOwnerByRecord.get(record);
    if (cached && cachedOwner?.isLive() === true) {
      return cached;
    }
    if (cachedOwner) {
      cachedOwner.dispose();
      registeredAdmissionOwnerByRecord.delete(record);
    }
    const channel = readChannel(record);
    if (
      (record.origin !== "bundled" && record.trustedOfficialInstall !== true) ||
      !registry.channels.some((entry) => entry.pluginId === record.id) ||
      !isPluginRecordActive(registry, record)
    ) {
      return channel;
    }
    let closed = false;
    const ownsLiveRegistrySlot = () =>
      !closed &&
      registeredRuntimeRecordById.get(record.id) === record &&
      isPluginRecordActive(registry, record);
    const previousRecord = registeredRuntimeRecordById.get(record.id);
    if (previousRecord && previousRecord !== record) {
      registeredAdmissionOwnerByRecord.get(previousRecord)?.dispose();
      registeredAdmissionOwnerByRecord.delete(previousRecord);
      revokePluginRecord(registry, previousRecord);
    }
    registeredRuntimeRecordById.set(record.id, record);
    const resolveGatewayContext = getGatewayContextResolver(registryParams.runtime.subagent);
    const scopedGatewayContext = resolveGatewayContext
      ? () => (ownsLiveRegistrySlot() ? resolveGatewayContext() : undefined)
      : undefined;
    if (scopedGatewayContext && resolveGatewayContext) {
      bindGatewayContextResolver(
        scopedGatewayContext,
        getCanonicalGatewayContextResolver(resolveGatewayContext),
      );
    }
    const owner = Object.freeze({
      channelId: record.id,
      resolveGatewayContext: scopedGatewayContext,
      isLive: ownsLiveRegistrySlot,
    });
    registeredAdmissionOwnerByRecord.set(record, {
      isLive: owner.isLive,
      dispose: () => {
        closed = true;
      },
    });
    const buildHostContext = createHostChannelInboundEventContextBuilder(
      channel.inbound.buildContext,
      owner,
    );
    function buildContext(
      params: BuildContextParams & { resolveSupplementalMedia: true },
    ): Promise<BuiltContext>;
    function buildContext(params: BuildContextParams): BuiltContext;
    function buildContext(params: BuildContextParams): BuiltContext | Promise<BuiltContext> {
      // Audit provenance is passive: stale closures still build the message context,
      // but only the exact live trusted owner may attach participant evidence.
      return buildHostContext(params);
    }
    const inbound = {
      ...channel.inbound,
      ingress: createHostChannelIngressRuntime(owner),
      buildContext,
    };
    const scoped = {
      ...channel,
      inbound,
      turn: inbound,
    } satisfies PluginRuntime["channel"];
    registeredChannelRuntime.set(record, scoped);
    return scoped;
  };

  return {
    resolve: resolveRecordChannelRuntime,
    revoke: (pluginId: string, record: PluginRecord) => {
      revokePluginRecord(registry, record);
      registeredAdmissionOwnerByRecord.get(record)?.dispose();
      registeredAdmissionOwnerByRecord.delete(record);
      if (registeredRuntimeRecordById.get(pluginId) === record) {
        registeredRuntimeRecordById.delete(pluginId);
      }
    },
  };
}
