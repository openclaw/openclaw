import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import type { Deferred } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import * as inProcessDispatch from "./server-plugin-in-process-dispatch.js";
import { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";

const HOST_PLUGIN_ID = "test-completion";
const PINNED_KEY = "sk-pinned-primary";

type RecordedHit = {
  authorization: string | undefined;
};

function providerModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

async function waitForHit(arrival: Promise<void>, work: Promise<unknown>, label: string) {
  await Promise.race([
    arrival,
    work.then((value) => {
      throw new Error(`${label} settled before the provider request: ${JSON.stringify(value)}`);
    }),
  ]);
}

function writeAuthFailure(response: ServerResponse) {
  response.writeHead(401, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        message: "ExpiredTokenException: The security token included in the request is expired",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    }),
  );
}

function writeCompletion(response: ServerResponse, text: string) {
  writeOpenAiResponsesSse(response, [
    {
      id: "transport-response",
      object: "chat.completion.chunk",
      model: "fallback-model",
      choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
    },
  ]);
}

describe("plugin background completion transport", () => {
  afterEach(async () => {
    resetCommandQueueStateForTest();
    resetConfigRuntimeState();
    await resetPreparedModelRuntimeSnapshotsForTest();
    clearPluginMetadataLifecycleCaches();
    resetPluginLoaderTestStateForTest();
  });

  async function withLocalCompletion(
    run: (params: {
      complete: () => Promise<{ text: string }>;
      hits: RecordedHit[];
      arrivals: Deferred[];
      respond: (index: number, write: (response: ServerResponse) => void) => void;
    }) => Promise<void>,
  ) {
    const roots = createSyncSuiteTempRootTracker("plugin-complete-transport");
    const root = fs.realpathSync(roots.makeTempDir());
    const providerDir = path.join(root, "provider");
    fs.mkdirSync(providerDir);
    const fixture = createColdPluginFixture({
      rootDir: providerDir,
      pluginId: "isolated-complete-fixture",
      providerId: "isolated-complete-provider",
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
        api.registerProvider({
          id: ${JSON.stringify(fixture.providerId)}, label: "Isolated complete transport", auth: [],
        });
      } };`,
    );
    const hits: RecordedHit[] = [];
    const pending = new Map<number, ServerResponse>();
    const arrivals = [createDeferred(), createDeferred(), createDeferred()];
    const server = createServer((request, response) => {
      request.resume();
      const index = hits.length;
      hits.push({ authorization: request.headers.authorization });
      pending.set(index, response);
      arrivals[index]?.resolve();
    });
    const respond = (index: number, write: (response: ServerResponse) => void) => {
      const response = pending.get(index);
      if (!response) {
        throw new Error(`missing provider response ${index}`);
      }
      write(response);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("transport fixture has no TCP port");
      }
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: root, model: `${fixture.providerId}/fallback-model` },
          entries: {
            research: {
              model: {
                primary: `${fixture.providerId}/primary-model`,
                fallbacks: [`${fixture.providerId}/fallback-model`],
              },
            },
          },
        },
        models: {
          providers: {
            [fixture.providerId]: {
              api: "openai-completions",
              apiKey: PINNED_KEY,
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              request: { allowPrivateNetwork: true },
              models: [providerModel("primary-model"), providerModel("fallback-model")],
            },
          },
        },
        plugins: {
          load: { paths: [fixture.rootDir] },
          slots: { memory: "none" },
          entries: { [fixture.pluginId]: { enabled: true } },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const lifetime = new AbortController();
      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      const complete = () =>
        withPluginRuntimePluginScope({ pluginId: HOST_PLUGIN_ID }, () =>
          createGatewaySubagentRuntime(() => context, {}, lifetime.signal).complete({
            agentId: "research",
            message: "Recover from the expired primary.",
            timeoutMs: 15_000,
          }),
        );
      try {
        await withEnvAsync(
          {
            ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            HTTP_PROXY: undefined,
            HTTPS_PROXY: undefined,
            http_proxy: undefined,
            https_proxy: undefined,
            ALL_PROXY: undefined,
            all_proxy: undefined,
            NO_PROXY: "127.0.0.1,localhost,::1",
          },
          async () => await run({ complete, hits, arrivals, respond }),
        );
      } finally {
        lifetime.abort();
      }
    } finally {
      for (const response of pending.values()) {
        if (!response.destroyed && !response.writableEnded) {
          response.destroy();
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      roots.cleanup();
    }
  }

  it("recovers through isolated inference without substituting another account for the pinned primary", async () => {
    await withLocalCompletion(async ({ complete, hits, arrivals, respond }) => {
      const recovered = complete();
      await waitForHit(arrivals[0]!.promise, recovered, "primary recovery");
      expect(hits[0]?.authorization).toBe(`Bearer ${PINNED_KEY}`);
      respond(0, writeAuthFailure);
      await waitForHit(arrivals[1]!.promise, recovered, "fallback recovery");
      respond(1, (response) => writeCompletion(response, "fallback-ok"));
      await expect(recovered).resolves.toEqual({ text: "fallback-ok" });
      expect(hits).toHaveLength(2);
    });
  });

  it("rejects expired caller authority before the fallback request", async () => {
    await withLocalCompletion(async ({ complete, hits, arrivals, respond }) => {
      const profile = ensureProfileForEmail("completion-transport@example.com");
      let pending: Promise<{ text: string }> | undefined;
      await inProcessDispatch.withOperatorToolGatewayAuthority(
        {
          authenticatedUserProfile: {
            profileId: profile.id,
            displayName: "Completion operator",
            hasAvatar: false,
            updatedAt: 1,
          },
          scopes: ["operator.write"],
        },
        async () => {
          pending = complete();
          await waitForHit(arrivals[0]!.promise, pending, "expired-authority primary");
        },
      );
      expect(hits).toHaveLength(1);
      expect(hits[0]?.authorization).toBe(`Bearer ${PINNED_KEY}`);
      respond(0, writeAuthFailure);
      await expect(pending).rejects.toThrow(/operator tool invocation authority expired/i);
      expect(hits).toHaveLength(1);
    });
  });
});
