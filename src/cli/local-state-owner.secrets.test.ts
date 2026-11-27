import path from "node:path";
import { expect, it, vi } from "vitest";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveCommandSecretRefsViaGateway } from "./command-secret-gateway.js";
import { useLocalStateOwnerFixture } from "./local-state-owner.fixture.test-support.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { getModelsCommandSecretTargetIds } from "./model-secret-targets.js";

const fixture = useLocalStateOwnerFixture();

it.each([
  ["same offline target", 0],
  ["hosted Gateway", 1],
  ["different config", 1],
  ["different state root", 1],
  ["remote Gateway", 1],
  ["explicit URL", 1],
  ["explicit port", 1],
] as const)("resolves a nested model SecretRef with %s", async (target, expectedRequests) => {
  vi.stubEnv(
    "OPENCLAW_GATEWAY_URL",
    target === "explicit URL" ? "ws://localhost:12345" : undefined,
  );
  vi.stubEnv("OPENCLAW_GATEWAY_PORT", target === "explicit port" ? "12345" : undefined);
  vi.stubEnv("FIXTURE_NESTED_MODEL_KEY", "synthetic-model-value");
  const otherRoot =
    target === "different state root" ? fixture.roots.make("other-gateway-") : undefined;
  if (target === "hosted Gateway") {
    await fixture.startOwner();
  }
  fixture.transport.gatewayContext = true;
  fixture.transport.request.mockRejectedValue(new Error("fixture Gateway unavailable"));

  const operation = { method: "infer model run", params: {}, target: "model credentials" };
  const result = await runWithLocalStateOwner({
    ...operation,
    runLocal: async ({ env }) => {
      if (otherRoot) {
        vi.stubEnv("OPENCLAW_STATE_DIR", otherRoot);
        await fixture.startOwner();
        fixture.transport.gatewayContext = true;
      }
      if (target === "different config") {
        vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(env.OPENCLAW_STATE_DIR!, "other.json"));
      }
      return await runWithLocalStateOwner({
        ...operation,
        runLocal: ({ localGatewayAbsent }) =>
          resolveCommandSecretRefsViaGateway({
            commandName: "infer model run",
            targetIds: getModelsCommandSecretTargetIds(),
            config: {
              gateway: { mode: target === "remote Gateway" ? "remote" : "local" },
              models: {
                providers: {
                  fixture: {
                    baseUrl: "https://model.example.test/v1",
                    models: [],
                    apiKey: { source: "env", provider: "default", id: "FIXTURE_NESTED_MODEL_KEY" },
                  },
                },
              },
            },
            localGatewayAbsent,
          }),
      });
    },
  });

  expect(result.resolvedConfig.models?.providers?.fixture?.apiKey).toBe("synthetic-model-value");
  expect(fixture.transport.request).toHaveBeenCalledTimes(expectedRequests);
  if (expectedRequests) {
    expect(fixture.transport.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "secrets.resolve" }),
    );
  }
});

it("expires the offline hint before the owner finishes closing its resources", async () => {
  fixture.transport.gatewayContext = true;
  const duringClose = Promise.withResolvers<void>();
  const observed: Array<true | undefined> = [];
  const operation = { method: "infer model run", params: {}, target: "model credentials" };
  await runWithLocalStateOwner({
    ...operation,
    runLocal: async () => {
      const nested = duringClose.promise.then(() =>
        runWithLocalStateOwner({
          ...operation,
          runLocal: async ({ localGatewayAbsent }) => {
            observed.push(localGatewayAbsent);
          },
        }),
      );
      getOpenClawDatabaseMaintenanceScope()!.own({}, "agent-resources", async () => {
        duringClose.resolve();
        await nested;
      });
    },
  });
  expect(observed).toEqual([undefined]);
});

it("rejects a detached nested command after another Gateway acquires the same state", async () => {
  const resume = Promise.withResolvers<void>();
  const runLocal = vi.fn();
  const operation = { method: "infer model run", params: {}, target: "model credentials" };
  fixture.transport.gatewayContext = true;
  let detached: Promise<unknown>;
  await runWithLocalStateOwner({
    ...operation,
    runLocal: async () => {
      detached = resume.promise.then(() => runWithLocalStateOwner({ ...operation, runLocal }));
    },
  });
  await fixture.startOwner();
  fixture.transport.gatewayContext = true;
  resume.resolve();
  await expect(detached!).rejects.toThrow("state process owner is no longer current");
  expect(runLocal).not.toHaveBeenCalled();
});
