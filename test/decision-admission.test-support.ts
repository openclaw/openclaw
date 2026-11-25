import assert from "node:assert/strict";
import fs from "node:fs";
import { json } from "node:stream/consumers";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../src/agents/prepared-model-runtime.test-support.js";
import { clearRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { withServer } from "../src/plugin-sdk/test-helpers/http-test-server.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { resetPluginLoaderTestStateForTest } from "../src/plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../src/plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../src/plugins/plugin-metadata-snapshot.js";
import { createColdPluginHermeticEnv } from "../src/plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../src/test-utils/openclaw-test-state.js";
import { VERSION } from "../src/version.js";
import { respondJson } from "./helpers/gateway-integration-fixtures.js";

type CapturedRequest = {
  url?: string;
  method?: string;
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};
export type AdmissionFixture = {
  state: OpenClawTestState;
  baseUrl: string;
  received: CapturedRequest[];
};

export function admissionPlugin(provider: string, config: OpenClawConfig, workspaceDir: string) {
  const metadata = resolvePluginMetadataSnapshot({ config, env: process.env, workspaceDir });
  const manifest = metadata.byPluginId.get(provider);
  assert(manifest, `Missing source ${provider} metadata`);
  const record = createPluginRecord({
    ...manifest,
    enabled: true,
    configSchema: Boolean(manifest.configSchema),
  });
  return { metadata, manifest, record };
}

export async function resetAdmissionState(prepared = false) {
  if (prepared) {
    await resetPreparedModelRuntimeSnapshotsForTest();
  }
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
}

export async function withAdmissionFixture(
  provider: "baseten",
  responseBody: unknown,
  run: (fixture: AdmissionFixture) => Promise<void>,
  beforeReply?: (requestNumber: number) => Promise<void>,
) {
  const state = await createOpenClawTestState({ label: `${provider}-authority`, applyEnv: false });
  const bundledPluginsDir = state.path("bundled");
  const received: CapturedRequest[] = [];
  try {
    fs.mkdirSync(bundledPluginsDir);
    await withServer(
      (request, response) => {
        const incoming: CapturedRequest = {
          url: request.url,
          method: request.method,
          authorization: request.headers.authorization,
          headers: request.headers,
          body: undefined,
        };
        const requestNumber = received.push(incoming);
        void json(request)
          .then(async (body) => {
            incoming.body = body;
            if (beforeReply) {
              await beforeReply(requestNumber);
            }
            respondJson(response, responseBody);
          })
          .catch((error: unknown) => {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          });
      },
      (baseUrl) =>
        withEnvAsync(
          {
            ...createColdPluginHermeticEnv(state.root, { bundledPluginsDir }),
            ...state.envVars,
            OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            BASETEN_API_KEY: undefined,
            HTTP_PROXY: undefined,
            HTTPS_PROXY: undefined,
            ALL_PROXY: undefined,
            http_proxy: undefined,
            https_proxy: undefined,
            all_proxy: undefined,
          },
          () => run({ state, baseUrl, received }),
        ),
    );
  } finally {
    await state.cleanup();
  }
}
