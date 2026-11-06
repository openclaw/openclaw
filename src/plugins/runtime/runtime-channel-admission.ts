import { createHostChannelInboundEventContextBuilder } from "../../channels/inbound-event/host-context-builder.js";
import type { ChannelIngressHostOwner } from "../../channels/message-access/ingress-host-owner.js";
import { createHostChannelIngressRuntime } from "../../channels/message-access/runtime.js";
import type { PluginRuntime } from "./types.js";

type InboundRuntime = PluginRuntime["channel"]["inbound"];
type BuildContextParams = Parameters<InboundRuntime["buildContext"]>[0];
type BuiltContext = ReturnType<InboundRuntime["buildContext"]>;

/** Host admission loads with channel execution, not provider-only registry construction. */
export function createHostChannelInboundRuntime(
  inbound: InboundRuntime,
  owner: ChannelIngressHostOwner,
): InboundRuntime {
  const buildHostContext = createHostChannelInboundEventContextBuilder(inbound.buildContext, owner);
  function buildContext(
    params: BuildContextParams & { resolveSupplementalMedia: true },
  ): Promise<BuiltContext>;
  function buildContext(params: BuildContextParams): BuiltContext;
  function buildContext(params: BuildContextParams): BuiltContext | Promise<BuiltContext> {
    // Stale closures still build context, but only the exact live trusted owner
    // may attach participant evidence.
    return buildHostContext(params);
  }
  return {
    ...inbound,
    ingress: createHostChannelIngressRuntime(owner),
    buildContext,
  };
}
