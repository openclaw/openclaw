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

type RuntimeBuilder = ReturnType<typeof createRuntimeBuilder>;

function resolveChannelRuntimeFor(builder: RuntimeBuilder) {
  const runtime = builder.registryBuilder.registry.channels
    .find((candidate) => candidate.plugin.id === builder.record.id)
    ?.resolveChannelRuntime?.();
  if (!runtime) {
    throw new Error(`missing registered channel runtime for ${builder.record.id}`);
  }
  return runtime;
}

/** Admit a fresh participant through `builder` and read the Gateway binding it retains. */
async function admitFresh(builder: RuntimeBuilder, participantId: string) {
  const runtime = resolveChannelRuntimeFor(builder);
  const ingress = await resolveIngressForRuntime(runtime, participantId, {
    channelId: builder.record.id,
  });
  const context = runtime.inbound.buildContext(
    contextParams({ ingress, channelId: builder.record.id, senderId: participantId }),
  );
  return readChannelContextGatewayContextResolver(context);
}

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
        expect(resolveChannelRuntimeFor(first).inbound.ingress).toBeUndefined();
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
          expect(resolveChannelRuntimeFor(first).inbound.ingress).toBeUndefined();
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

  // Repeated failures must each hand the slot back to the same original owner, and a later
  // commit must still take it: the retired candidates are compacted out, not stacked up.
  it("restores the same predecessor after repeated failed replacements", async () => {
    const original = captureActivePluginRegistrySnapshot();
    const gatewayContext = {} as GatewayRequestContext;
    const gatewayContextResolver = vi.fn<GatewayContextResolver>(() => gatewayContext);
    const first = createRuntimeBuilder({
      origin: "bundled",
      id: "restaged-channel-owner",
      gatewayContextResolver,
    });
    const candidates: RuntimeBuilder[] = [];
    const stageCandidate = () => {
      const candidate = createRuntimeBuilder({
        origin: "bundled",
        id: first.record.id,
        gatewayContextResolver,
      });
      candidates.push(candidate);
      stageActivePluginRegistry(candidate.registryBuilder.registry, null, "gateway-bindable");
      return candidate;
    };
    try {
      setActivePluginRegistry(first.registryBuilder.registry);
      const committed = captureActivePluginRegistrySnapshot();
      const ingress = await first.resolveIngress("person-a", { channelId: first.record.id });
      const context = first.buildContext(contextParams({ ingress, channelId: first.record.id }));
      const copied = { ...context };
      copyChannelParticipantAdmissionEvidence(context, copied);
      const retained = readChannelContextGatewayContextResolver(copied);
      expect(retained?.()).toBe(gatewayContext);

      // No traffic reaches the predecessor between failures, so nothing re-heads the slot
      // history for it; each candidate claims behind the one before it.
      for (const attempt of ["first", "second", "third"]) {
        stageCandidate();
        expect(retained?.(), `staged ${attempt} candidate`).toBeUndefined();
        rollbackStagedPluginRegistry(committed);
        expect(getActivePluginRegistry()).toBe(first.registryBuilder.registry);
        expect(retained?.(), `rolled back ${attempt} candidate`).toBe(gatewayContext);
      }
      expect((await admitFresh(first, "person-b"))?.()).toBe(gatewayContext);

      const successor = stageCandidate();
      commitStagedPluginRegistry(
        first.registryBuilder.registry,
        successor.registryBuilder.registry,
      );
      expect(getActivePluginRegistry()).toBe(successor.registryBuilder.registry);
      expect(retained?.()).toBeUndefined();
      expect((await admitFresh(successor, "person-c"))?.()).toBe(gatewayContext);
    } finally {
      restoreActivePluginRegistrySnapshot(original);
      markPluginRegistryRetired(first.registryBuilder.registry);
      for (const candidate of candidates) {
        markPluginRegistryRetired(candidate.registryBuilder.registry);
      }
    }
  });
});
