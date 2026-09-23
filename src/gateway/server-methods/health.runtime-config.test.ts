// The health RPC returns runtime-config drift only to clients that advertise it.
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import type { HealthSummary } from "../health/types.js";
import { healthHandlers } from "./health.js";

const runtimeConfig: NonNullable<HealthSummary["runtimeConfig"]> = {
  state: "drift",
  driftPaths: ["agents.defaults.model"],
  liveDefaultModel: "openai/gpt-5.6-sol",
  observedDefaultModel: "openai/gpt-5.6-terra",
};

function healthWithRuntimeConfig(): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    agents: [],
    sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
    runtimeConfig,
  };
}

async function requestHealth(params: { cached: boolean; caps?: string[] }) {
  const snapshot = healthWithRuntimeConfig();
  const respond = vi.fn();
  await healthHandlers.health!({
    req: {} as never,
    params: {},
    respond: respond as never,
    context: {
      getHealthCache: () => (params.cached ? snapshot : null),
      refreshHealthSnapshot: vi.fn(async () => snapshot),
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      logHealth: { error: vi.fn() },
    } as never,
    client: {
      connect: { role: "operator", scopes: ["operator.read"], caps: params.caps },
    } as never,
    isWebchatConnect: () => false,
  });
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  expect(snapshot.runtimeConfig).toBe(runtimeConfig);
  return respond.mock.calls[0]?.[1] as HealthSummary;
}

describe("health RPC runtime-config capability", () => {
  it.each([true, false])(
    "omits runtimeConfig unless the client advertises runtime-config-health (cached: %s)",
    async (cached) => {
      await withStateDirEnv("openclaw-health-runtime-config-", async () => {
        const legacy = await requestHealth({ cached });
        const advertised = await requestHealth({
          cached,
          caps: [GATEWAY_CLIENT_CAPS.RUNTIME_CONFIG_HEALTH],
        });

        expect(legacy).not.toHaveProperty("runtimeConfig");
        expect(legacy.ok).toBe(true);
        expect(advertised.runtimeConfig).toEqual(runtimeConfig);
      });
    },
  );
});
