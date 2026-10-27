import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  respondJson,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
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
import { gatewayProfile } from "./server/client-fixtures.test-support.js";

const HOST_PLUGIN_ID = "test-completion";
const PINNED_KEY = "sk-pinned-primary";

const waitForHit = (arrival: Promise<ServerResponse>, work: Promise<unknown>, label: string) =>
  awaitGateBeforeSettlement(arrival, work, `${label} settled before the provider request`);

function writeAuthFailure(response: ServerResponse) {
  respondJson(
    response,
    {
      error: {
        message: "ExpiredTokenException: The security token included in the request is expired",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    },
    401,
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
      hits: Array<string | undefined>;
      arrivals: Deferred<ServerResponse>[];
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
    const hits: Array<string | undefined> = [];
    const arrivals = [createDeferred<ServerResponse>(), createDeferred<ServerResponse>()];
    const server = createServer((request, response) => {
      request.resume();
      const index = hits.length;
      hits.push(request.headers.authorization);
      arrivals[index]?.resolve(response);
    });
    try {
      const origin = await listenLoopback(server);
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
              baseUrl: `${origin}/v1`,
              request: { allowPrivateNetwork: true },
              models: ["primary-model", "fallback-model"].map((id) =>
                modelDefinition(id, { reasoning: false, contextWindow: 8192, maxTokens: 1024 }),
              ),
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
          async () => await run({ complete, hits, arrivals }),
        );
      } finally {
        lifetime.abort();
      }
    } finally {
      await closeHttpServer(server);
      roots.cleanup();
    }
  }

  it.each([false, true])(
    "fallback respects pinned credentials and expired authority=%s",
    async (expired) => {
      await withLocalCompletion(async ({ complete, hits, arrivals }) => {
        let pending!: Promise<{ text: string }>;
        let primary!: ServerResponse;
        const start = async () => {
          pending = complete();
          primary = await waitForHit(arrivals[0]!.promise, pending, "primary");
        };
        if (expired) {
          const profile = ensureProfileForEmail("completion-transport@example.com");
          await inProcessDispatch.withOperatorToolGatewayAuthority(
            {
              authenticatedUserProfile: gatewayProfile(profile.id, "Completion operator"),
              scopes: ["operator.write"],
            },
            start,
          );
        } else {
          await start();
        }
        expect(hits).toEqual([`Bearer ${PINNED_KEY}`]);
        writeAuthFailure(primary);
        if (expired) {
          await expect(pending).rejects.toThrow(/operator tool invocation authority expired/i);
          expect(hits).toHaveLength(1);
        } else {
          const fallback = await waitForHit(arrivals[1]!.promise, pending, "fallback recovery");
          writeCompletion(fallback, "fallback-ok");
          await expect(pending).resolves.toEqual({ text: "fallback-ok" });
          expect(hits).toHaveLength(2);
        }
      });
    },
  );
});
