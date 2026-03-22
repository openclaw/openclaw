import { beforeEach, describe, expect, it } from "vitest";
import { ensureBrightDataZoneExists, resetEnsuredBrightDataZones } from "./provider-web-search.js";

type ZoneEnsureParams = Parameters<typeof ensureBrightDataZoneExists>[0];
type TrustedEndpointRunner = ZoneEnsureParams["requestEndpoint"];

function createZoneRunner(calls: string[]): TrustedEndpointRunner {
  return async (params, run) => {
    calls.push(params.url);
    if (params.url.endsWith("/zone/get_active_zones")) {
      return await run({
        response: new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        finalUrl: params.url,
      });
    }
    if (params.url.endsWith("/zone")) {
      return await run({
        response: new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        finalUrl: params.url,
      });
    }
    throw new Error(`Unexpected URL in test mock: ${params.url}`);
  };
}

describe("provider-web-search Bright Data zone bootstrap", () => {
  beforeEach(() => {
    resetEnsuredBrightDataZones();
  });

  it("shares the zone bootstrap cache across callers", async () => {
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const firstRunner = createZoneRunner(firstCalls);
    const secondRunner = createZoneRunner(secondCalls);

    const zoneParams = {
      apiToken: "brightdata-test-token",
      baseUrl: "https://api.brightdata.com",
      zoneName: "mcp_unlocker",
      kind: "unlocker" as const,
      timeoutSeconds: 30,
    };

    const [first, second] = await Promise.all([
      ensureBrightDataZoneExists({
        ...zoneParams,
        requestEndpoint: firstRunner,
      }),
      ensureBrightDataZoneExists({
        ...zoneParams,
        requestEndpoint: secondRunner,
      }),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(firstCalls).toEqual([
      "https://api.brightdata.com/zone/get_active_zones",
      "https://api.brightdata.com/zone",
    ]);
    expect(secondCalls).toEqual([]);
  });
});
