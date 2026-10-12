import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { WorkerLiveEventParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

type NativeInferenceFixture = {
  setup: () => Promise<{
    gateway: {
      disconnectClients(): void;
      liveEventRequests: WorkerLiveEventParams[];
    };
    workspaceDir: string;
    launch: WorkerLaunchDescriptor;
  }>;
};

export function registerWorkerNativeInferenceTests({ setup }: NativeInferenceFixture): void {
  it("revokes an active native provider request when Gateway admission is lost", async () => {
    const requestStarted = createDeferred();
    const requestClosed = createDeferred();
    let providerRequests = 0;
    const provider = createServer((request, response) => {
      providerRequests += 1;
      expect(request.headers.authorization).toBe("Bearer worker-native-provider-credential");
      response.once("close", () => requestClosed.resolve());
      requestStarted.resolve();
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("native provider fixture did not allocate a TCP port");
    }

    try {
      const { gateway, workspaceDir, launch } = await setup();
      launch.assignment.inference = "runtime-local";
      launch.assignment.modelRef = { provider: "fixture", model: "fixture-model" };
      const result = runWorkerDescriptor(launch, {
        nativeInference: {
          config: {
            workspace: workspaceDir,
            models: [
              {
                provider: "fixture",
                id: "fixture-model",
                api: "openai-completions",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                contextWindow: 8_192,
                maxTokens: 256,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
          credentials: { "fixture/fixture-model": "worker-native-provider-credential" },
        },
      });
      await requestStarted.promise;

      gateway.disconnectClients();

      await expect(result).resolves.toMatchObject({ status: "failed", reason: "turn-failed" });
      await requestClosed.promise;
      expect(providerRequests).toBe(1);
      expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
        kind: "lifecycle",
        payload: { phase: "finishing", stopReason: "aborted" },
      });
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}
