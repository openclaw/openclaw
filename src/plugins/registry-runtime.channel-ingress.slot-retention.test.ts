import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { describe, expect, it } from "vitest";

const imports = `
  import {collectForRetentionCheck} from ${JSON.stringify(new URL("../test-utils/retention.js", import.meta.url).href)};
  import {readChannelContextGatewayContextResolver} from ${JSON.stringify(new URL("../channels/message-access/admission-evidence.js", import.meta.url).href)};
  import {isChannelRecordSuperseded} from ${JSON.stringify(new URL("./channel-gateway-root-slots.js", import.meta.url).href)};
  import {markPluginRegistryRetired} from ${JSON.stringify(new URL("./registry-lifecycle.js", import.meta.url).href)};
  import {contextParams, createRuntimeBuilder} from ${JSON.stringify(new URL("./registry-runtime.channel-ingress.test-support.js", import.meta.url).href)};
`;

/** Run a slot-history probe in a child with `--expose-gc` and read its single JSON line. */
async function runRetentionProbe(body: string) {
  const fixture = spawn(
    process.execPath,
    [
      "--expose-gc",
      ...(process.versions.bun ? [] : ["--import", import.meta.resolve("tsx")]),
      "--input-type=module",
      "-e",
      `${imports}\n${body}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const [stdout, stderr, [code]] = await Promise.all([
    text(fixture.stdout),
    text(fixture.stderr),
    once(fixture, "close"),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

// Channel generations on one Gateway root displace each other. The slot history must retain only
// the live owner: left owning its predecessors, it pins one whole retired plugin registry per
// generation for the Gateway root's lifetime, and every supersession walk crosses all of them.
describe("channel Gateway slot history retention", () => {
  it("releases failed replacement generations", async () => {
    const result = await runRetentionProbe(`
      const gatewayContext = {};
      const gatewayContextResolver = () => gatewayContext;
      const first = createRuntimeBuilder({
        origin: "bundled",
        id: "retained-channel-owner",
        gatewayContextResolver,
      });
      const ingress = await first.resolveIngress("person-a", {channelId: first.record.id});
      const retained = readChannelContextGatewayContextResolver(
        first.buildContext(contextParams({ingress, channelId: first.record.id})),
      );
      const liveBeforeFailures = retained?.() === gatewayContext;

      // Each candidate claims the slot on the same Gateway root, then retires without committing.
      const generations = [];
      const failOneGeneration = (tracked) => {
        const candidate = createRuntimeBuilder({
          origin: "bundled",
          id: first.record.id,
          gatewayContextResolver,
        });
        markPluginRegistryRetired(candidate.registryBuilder.registry);
        if (tracked) generations.push(new WeakRef(candidate.registryBuilder.registry));
      };
      for (let index = 0; index < 6; index++) failOneGeneration(index < 5);

      // The live owner is still held, so nothing below collects by losing its own root.
      const supersededAfterFailures = isChannelRecordSuperseded(first.record);
      await collectForRetentionCheck("channel-gateway-slot-failed");
      console.log(JSON.stringify({
        liveBeforeFailures,
        supersededAfterFailures,
        liveOwnerStillHeld: first.record.id === "retained-channel-owner",
        trackedGenerations: generations.length,
        retainedGenerations: generations.filter((reference) => reference.deref()).length,
      }));
    `);
    expect(result).toEqual({
      // A retired candidate never superseded the predecessor, and never owned the slot.
      liveBeforeFailures: true,
      supersededAfterFailures: false,
      liveOwnerStillHeld: true,
      trackedGenerations: 5,
      retainedGenerations: 0,
    });
  }, 120_000);

  it("releases committed generations held only by a stale binding's chain", async () => {
    const result = await runRetentionProbe(`
      const gatewayContext = {};
      const gatewayContextResolver = () => gatewayContext;
      let live = createRuntimeBuilder({
        origin: "bundled",
        id: "committed-channel-owner",
        gatewayContextResolver,
      });
      // The first generation stays held, exactly as a long-lived admitted binding holds it.
      const oldest = live;
      const ingress = await oldest.resolveIngress("person-a", {channelId: oldest.record.id});
      const retained = readChannelContextGatewayContextResolver(
        oldest.buildContext(contextParams({ingress, channelId: oldest.record.id})),
      );
      const liveBeforeReplacements = retained?.() === gatewayContext;

      // Commit leaves the successor live and retires the predecessor's registry.
      const generations = [];
      const commitOneGeneration = (tracked) => {
        const successor = createRuntimeBuilder({
          origin: "bundled",
          id: live.record.id,
          gatewayContextResolver,
        });
        markPluginRegistryRetired(live.registryBuilder.registry);
        if (tracked) generations.push(new WeakRef(live.registryBuilder.registry));
        live = successor;
      };
      // The oldest generation is held by this fixture, so only generations 1..5 are tracked.
      for (let index = 0; index < 7; index++) commitOneGeneration(index >= 1 && index <= 5);

      const supersededLive = isChannelRecordSuperseded(live.record);
      // Redeeming the stale binding runs the production fence over the chain.
      const staleBindingRedeems = retained?.() === gatewayContext;
      const supersededOldest = isChannelRecordSuperseded(oldest.record);
      await collectForRetentionCheck("channel-gateway-slot-committed");
      console.log(JSON.stringify({
        liveBeforeReplacements,
        staleBindingRedeems,
        supersededOldest,
        supersededLive,
        liveOwnerStillHeld: live.record.id === "committed-channel-owner",
        trackedGenerations: generations.length,
        retainedGenerations: generations.filter((reference) => reference.deref()).length,
      }));
    `);
    expect(result).toEqual({
      liveBeforeReplacements: true,
      // Compacting the chain must not soften the fence: the oldest generation is still
      // reported superseded and its binding still refuses to resolve.
      staleBindingRedeems: false,
      supersededOldest: true,
      // The newest committed generation owns the slot and nothing supersedes it.
      supersededLive: false,
      liveOwnerStillHeld: true,
      trackedGenerations: 5,
      retainedGenerations: 0,
    });
  }, 120_000);
});
