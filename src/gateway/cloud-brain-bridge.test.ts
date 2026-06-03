import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BenchCloudBridgeConfig } from "./bench-cloud-client.js";
import { readBenchCloudCliTurnStatus } from "./bench-cloud-client.js";
import {
  createCliRemoteBrainTurn,
  resolveBenchCloudAgentId,
  resolveBenchCloudBridgeConfig,
} from "./cloud-brain-bridge.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function testBridgeConfig(
  overrides: Partial<BenchCloudBridgeConfig> = {},
): BenchCloudBridgeConfig & { instanceId: string } {
  return {
    enabled: true,
    apiBaseUrl: "https://benchagi.example",
    instanceId: "bench-01",
    agentIdAliases: {},
    pollIntervalMs: 100,
    pollTimeoutMs: 1000,
    ...overrides,
  };
}

describe("Bench cloud bridge agent aliases", () => {
  it("maps Cory's local Aurelius profile id to the canonical platform agent id", () => {
    const config = resolveBenchCloudBridgeConfig({} as OpenClawConfig);

    expect(resolveBenchCloudAgentId({ config, agentId: "kestrel-aurelius" })).toBe("aurelius");
    expect(resolveBenchCloudAgentId({ config, agentId: "Kestrel-Aurelius" })).toBe("aurelius");
  });

  it("keeps canonical ids stable and supports configured aliases", () => {
    const config = resolveBenchCloudBridgeConfig({
      gateway: {
        benchCloud: {
          agentIdAliases: {
            "local-sage": "sage",
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(resolveBenchCloudAgentId({ config, agentId: "aurelius" })).toBe("aurelius");
    expect(resolveBenchCloudAgentId({ config, agentId: "local-sage" })).toBe("sage");
  });

  it("sends canonical cloud agent ids when creating remote-brain turns", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          dispatch: "local",
          runtime: "local",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createCliRemoteBrainTurn({
      config: testBridgeConfig({
        agentIdAliases: {
          "local-sage": "sage",
        },
      }),
      authToken: "firebase-token",
      request: {
        agentId: "local-sage",
        sessionKey: "agent:local-sage:default",
        runId: "run-1",
        idempotencyKey: "run-1",
        message: "hello",
      },
    });

    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== "string") {
      throw new Error("expected JSON request body");
    }
    expect(JSON.parse(requestBody)).toMatchObject({
      agentId: "sage",
      instanceId: "bench-01",
    });
  });
});

describe("Bench cloud status URLs", () => {
  it("rejects status URLs outside the configured Bench cloud origin", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readBenchCloudCliTurnStatus({
        config: testBridgeConfig(),
        authToken: "firebase-token",
        statusUrl: "https://attacker.example/status/turn-1",
      }),
    ).rejects.toThrow("configured API origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
