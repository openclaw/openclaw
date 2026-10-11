import { describe, expect, it, vi } from "vitest";
import {
  copyChannelParticipantAdmissionEvidence,
  readChannelContextGatewayContextResolver,
} from "../channels/message-access/admission-evidence.js";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
} from "../gateway/server-methods/types.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import {
  contextParams,
  createRuntimeBuilder,
  resolveIngressForRuntime,
} from "./registry-runtime.channel-ingress.test-support.js";
import {
  captureActivePluginRegistrySnapshot,
  commitStagedPluginRegistry,
  getActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "./runtime.js";

// A staged replacement claims the channel's Gateway slot before activation commits.
// Rollback must hand that slot back to the exact predecessor; commit must not.
describe("channel Gateway slot across staged registry activation", () => {
  it.each(["rolled back", "committed"] as const)(
    "hands the channel Gateway slot back to its predecessor only when a staged replacement is %s",
    async (outcome) => {
      const original = captureActivePluginRegistrySnapshot();
      const gatewayContext = {} as GatewayRequestContext;
      const gatewayContextResolver = vi.fn<GatewayContextResolver>(() => gatewayContext);
      const first = createRuntimeBuilder({
        origin: "bundled",
        id: "staged-channel-owner",
        gatewayContextResolver,
      });
      const resolveRuntime = (builder: typeof first) => {
        const runtime = builder.registryBuilder.registry.channels
          .find((candidate) => candidate.plugin.id === builder.record.id)
          ?.resolveChannelRuntime?.();
        if (!runtime) {
          throw new Error(`missing registered channel runtime for ${builder.record.id}`);
        }
        return runtime;
      };
      const admitFresh = async (builder: typeof first, participantId: string) => {
        const runtime = resolveRuntime(builder);
        const ingress = await resolveIngressForRuntime(runtime, participantId, {
          channelId: builder.record.id,
        });
        const context = runtime.inbound.buildContext(
          contextParams({ ingress, channelId: builder.record.id, senderId: participantId }),
        );
        return readChannelContextGatewayContextResolver(context);
      };
      let replacement: typeof first | undefined;
      try {
        setActivePluginRegistry(first.registryBuilder.registry);
        const committed = captureActivePluginRegistrySnapshot();
        const ingress = await first.resolveIngress("person-a", { channelId: first.record.id });
        const context = first.buildContext(contextParams({ ingress, channelId: first.record.id }));
        const copied = { ...context };
        copyChannelParticipantAdmissionEvidence(context, copied);
        const retained = readChannelContextGatewayContextResolver(copied);
        expect(retained?.()).toBe(gatewayContext);

        // The replacement resolves its channel runtime on the same Gateway root, then stages.
        replacement = createRuntimeBuilder({
          origin: "bundled",
          id: first.record.id,
          gatewayContextResolver,
        });
        stageActivePluginRegistry(replacement.registryBuilder.registry, null, "gateway-bindable");
        gatewayContextResolver.mockClear();
        expect(retained?.()).toBeUndefined();
        // The predecessor's live channel keeps resolving its runtime while the candidate stages.
        expect(resolveRuntime(first).inbound.ingress).toBeUndefined();
        expect(gatewayContextResolver).not.toHaveBeenCalled();

        if (outcome === "rolled back") {
          rollbackStagedPluginRegistry(committed);
          expect(getActivePluginRegistry()).toBe(first.registryBuilder.registry);
          // The exact predecessor owner survives rollback, including bindings it already issued.
          expect(retained?.()).toBe(gatewayContext);
          expect((await admitFresh(first, "person-b"))?.()).toBe(gatewayContext);
        } else {
          commitStagedPluginRegistry(
            first.registryBuilder.registry,
            replacement.registryBuilder.registry,
          );
          expect(getActivePluginRegistry()).toBe(replacement.registryBuilder.registry);
          expect(retained?.()).toBeUndefined();
          expect(resolveRuntime(first).inbound.ingress).toBeUndefined();
          expect(gatewayContextResolver).not.toHaveBeenCalled();
          expect((await admitFresh(replacement, "person-b"))?.()).toBe(gatewayContext);
        }
      } finally {
        restoreActivePluginRegistrySnapshot(original);
        markPluginRegistryRetired(first.registryBuilder.registry);
        markPluginRegistryRetired(replacement?.registryBuilder.registry);
      }
    },
  );
});
