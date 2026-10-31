import assert from "node:assert/strict";
import fs from "node:fs";
import { json } from "node:stream/consumers";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { expect, vi } from "vitest";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../src/agents/prepared-model-runtime.test-support.js";
import { clearRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { withServer } from "../src/plugin-sdk/test-helpers/http-test-server.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { resetPluginLoaderTestStateForTest } from "../src/plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../src/plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../src/plugins/plugin-metadata-snapshot.js";
import { createColdPluginHermeticEnv } from "../src/plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../src/shared/deferred.js";
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
  provider: "levanto" | "subq" | "typesafe" | "baseten",
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
            [`${provider.toUpperCase()}_API_KEY`]:
              provider === "subq" ? "synthetic-subq-key" : undefined,
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

type FetchOptions = Parameters<typeof ssrfRuntime.fetchWithSsrFGuard>[0];
export function createAdmissionBarrier(
  nativeUrl: string,
  transport: Pick<FetchOptions, "url" | "fetchImpl"> & {
    lookupFn: ssrfRuntime.LookupFn;
    expectedHostname?: string;
  },
  requireHttps = false,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const barrier: { admission: "unreached" | "allowed" | "rejected" } = { admission: "unreached" };
  const { expectedHostname, ...overrides } = transport;
  const originalFetch = ssrfRuntime.fetchWithSsrFGuard;
  const forwarding = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation((params) => {
    expect(params.url).toBe(nativeUrl);
    expect(params.init?.method).toBe("POST");
    expect(params.beforeRequest).toBeTypeOf("function");
    if (requireHttps) {
      expect(params.requireHttps).toBe(true);
    }
    const beforeRequest = params.beforeRequest;
    // Keep the real guard and owner admission; only the final transport is synthetic.
    return originalFetch({
      ...params,
      ...overrides,
      lookupFn: async (hostname, options) => {
        if (expectedHostname) {
          expect(hostname).toBe(expectedHostname);
        }
        entered.resolve();
        await release.promise;
        return transport.lookupFn(hostname, options);
      },
      beforeRequest: () => {
        try {
          beforeRequest?.();
          barrier.admission = "allowed";
        } catch (error) {
          barrier.admission = "rejected";
          throw error;
        }
      },
    });
  });
  return {
    release,
    get admission() {
      return barrier.admission;
    },
    forwarding,
    wait: (settled: Promise<unknown>) =>
      Promise.race([
        entered.promise,
        settled.then((outcome) => {
          throw new Error("Decision settled before DNS preparation", { cause: outcome });
        }),
      ]),
  };
}
