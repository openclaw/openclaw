import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { describe, expect, it } from "vitest";

// A failed channel replacement is retired without ever owning the slot. The slot history must
// compact it away: left in place, each failed generation lengthens every supersession walk and
// strongly retains the next record together with its whole plugin registry.
describe("channel Gateway slot history across repeated failed replacements", () => {
  it("releases every failed generation except the slot's current claim", async () => {
    const source = `
      import {collectForRetentionCheck} from ${JSON.stringify(new URL("../test-utils/retention.js", import.meta.url).href)};
      import {readChannelContextGatewayContextResolver} from ${JSON.stringify(new URL("../channels/message-access/admission-evidence.js", import.meta.url).href)};
      import {isChannelRecordSuperseded} from ${JSON.stringify(new URL("./channel-gateway-root-slots.js", import.meta.url).href)};
      import {markPluginRegistryRetired} from ${JSON.stringify(new URL("./registry-lifecycle.js", import.meta.url).href)};
      import {contextParams, createRuntimeBuilder} from ${JSON.stringify(new URL("./registry-runtime.channel-ingress.test-support.js", import.meta.url).href)};

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
      await collectForRetentionCheck("channel-gateway-slot-history");
      console.log(JSON.stringify({
        liveBeforeFailures,
        supersededAfterFailures,
        liveOwnerStillHeld: first.record.id === "retained-channel-owner",
        trackedGenerations: generations.length,
        retainedGenerations: generations.filter((reference) => reference.deref()).length,
      }));
    `;
    const fixture = spawn(
      process.execPath,
      [
        "--expose-gc",
        ...(process.versions.bun ? [] : ["--import", import.meta.resolve("tsx")]),
        "--input-type=module",
        "-e",
        source,
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
    expect(JSON.parse(stdout)).toEqual({
      // The predecessor keeps the slot: a retired candidate never superseded it.
      liveBeforeFailures: true,
      supersededAfterFailures: false,
      liveOwnerStillHeld: true,
      trackedGenerations: 5,
      retainedGenerations: 0,
    });
  }, 120_000);
});
