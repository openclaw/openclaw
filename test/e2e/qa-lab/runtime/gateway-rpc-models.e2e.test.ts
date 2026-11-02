import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { withRpcGateway } from "./gateway-rpc.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it(
  "returns configured public model metadata without provider internals",
  { timeout: 30_000 },
  async () => {
    const modelRef = "fixture/catalog-model";
    await withRpcGateway(
      tempDirs.make("openclaw-rpc-models-"),
      {
        name: "rpc-models",
        config: (workspace) => ({
          agents: {
            defaults: {
              workspace,
              model: { primary: modelRef },
              models: { [modelRef]: { alias: "Catalog Alias" } },
            },
          },
          models: {
            mode: "replace",
            providers: {
              fixture: {
                apiKey: "rpc-model-secret",
                baseUrl: "http://127.0.0.1:9/v1",
                models: [
                  {
                    id: "catalog-model",
                    name: "Catalog Model",
                    contextWindow: 8192,
                    reasoning: true,
                    compat: { supportsTools: true },
                  },
                ],
              },
            },
          },
        }),
      },
      async (client) => {
        const payload = await client.request<{ models: Array<Record<string, unknown>> }>(
          "models.list",
          { view: "configured" },
        );
        expect(payload.models).toEqual([
          expect.objectContaining({
            alias: "Catalog Alias",
            contextWindow: 8192,
            id: "catalog-model",
            name: "Catalog Model",
            provider: "fixture",
            reasoning: true,
            supportsTools: true,
          }),
        ]);
        for (const field of ["agentRuntime", "apiKey", "baseUrl"]) {
          expect(payload.models[0] ?? {}).not.toHaveProperty(field);
        }
        expect(JSON.stringify(payload)).not.toContain("rpc-model-secret");
        await expect(client.request("models.list", { unexpected: true })).rejects.toThrow(
          /invalid models\.list params/i,
        );
      },
    );
  },
);
