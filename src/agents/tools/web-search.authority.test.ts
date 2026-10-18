// Real retained tool -> scoped SecretRef resolution -> Brave -> guarded loopback HTTP.
// No provider/fetch replacement: this proves local transport, not live Brave or cron admission.
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as secretResolver from "../../secrets/resolve.js";
import { createEmptyRuntimeWebToolsMetadata } from "../../secrets/runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotState,
} from "../../secrets/runtime-state.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "./gateway-caller-context.js";
import { createWebSearchTool } from "./web-search.js";

const temp = createSuiteTempRootTracker({ prefix: "web-search-authority-" });
const requests: Array<{ url: string; authenticated: boolean }> = [];
let listener: Awaited<ReturnType<typeof reserveTestPortListener>>;
let secretPath: string;
let config: OpenClawConfig;

function activate(cfg: OpenClawConfig) {
  activateSecretsRuntimeSnapshotState({
    snapshot: {
      sourceConfig: structuredClone(cfg),
      config: structuredClone(cfg),
      authStores: [],
      authStoreCredentialsRevision: 0,
      authStoreSnapshotsRevision: 0,
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    },
    refreshContext: {
      env: {},
      explicitAgentDirs: null,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    },
    refreshHandler: null,
  });
}

function retainedTool() {
  const tool = createWebSearchTool({
    config,
    lateBindRuntimeConfig: true,
    webSearchProvider: "brave",
  });
  if (!tool) {
    throw new Error("Expected retained search tool");
  }
  return tool;
}

beforeAll(async () => {
  secretPath = path.join(await temp.setup(), "secret.json");
  await fs.writeFile(secretPath, JSON.stringify({ key: "synthetic-loopback-key" }), {
    mode: 0o600,
  });
  listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        requests.push({
          url: request.url ?? "",
          authenticated: request.headers["x-subscription-token"] === "synthetic-loopback-key",
        });
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.end(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Loopback source",
                  url: "https://example.com/source",
                  description: "Synthetic result",
                },
              ],
            },
          }),
        );
      }),
  });
});

afterAll(async () => {
  await listener?.releaseListener();
  await listener?.claim.release();
  await temp.cleanup();
});

beforeEach(() => {
  requests.length = 0;
  config = {
    secrets: { providers: { fixture: { source: "file", path: secretPath, mode: "json" } } },
    tools: { web: { search: { provider: "duckduckgo", cacheTtlMinutes: 0 } } },
    plugins: {
      entries: {
        brave: {
          enabled: true,
          config: {
            webSearch: {
              apiKey: { source: "file", provider: "fixture", id: "/key" },
              baseUrl: `http://127.0.0.1:${listener.claim.port}`,
              mode: "web",
            },
          },
        },
      },
    },
  };
  activate(config);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSecretsRuntimeSnapshotState();
});

describe("retained scoped web_search transport authority", () => {
  it("sends an authenticated real request without publishing its scoped selection or credential", async () => {
    const activeBefore = structuredClone(getActiveSecretsRuntimeSnapshotState());
    const result = await retainedTool().execute("allowed", { query: "authority probe", count: 1 });
    expect(result.details).toMatchObject({ kind: "results", provider: "brave", count: 1 });
    expect(requests).toEqual([
      { url: "/res/v1/web/search?q=authority+probe&count=1", authenticated: true },
    ]);
    expect(getActiveSecretsRuntimeSnapshotState()).toEqual(activeBefore);
  });

  it("rejects a retained tool disabled before invocation without HTTP I/O", async () => {
    const tool = retainedTool();
    config.tools!.web!.search!.enabled = false;
    activate(config);
    await expect(tool.execute("disabled", { query: "authority probe" })).rejects.toThrow(
      "disabled",
    );
    expect(requests).toEqual([]);
  });

  it.each(["search", "plugin", "admitted run"] as const)(
    "rejects %s revocation while real credentials resolve without HTTP I/O",
    async (revocation) => {
      const admission = prepareAgentRunAdmission({
        cfg: config,
        facts: {
          runId: "search-authority-run",
          agentId: "main",
          ingress: { kind: "system", boundary: "search-authority-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef("search-authority-run"),
      });
      const identity = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: await admission.admit("embedded"),
        agentId: "main",
        sessionKey: "agent:main:cron:search-authority",
      });
      expect(identity?.receiptAuthority?.()).toBe(true);
      const tool = wrapToolWithGatewayCallerIdentity(retainedTool(), identity);
      const entered = createDeferred();
      const release = createDeferred();
      const resolve = secretResolver.resolveSecretRefValues;
      // Scheduling seam only: still perform the real permission-checked file resolution.
      vi.spyOn(secretResolver, "resolveSecretRefValues").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return resolve(...args);
      });
      const pending = tool.execute("revoked", { query: "authority probe" });
      // Observe settlement without an unhandled rejection while the barrier is held.
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await entered.promise;
        expect(requests).toEqual([]);
        if (revocation === "admitted run") {
          admission.close();
        } else {
          if (revocation === "search") {
            config.tools!.web!.search!.enabled = false;
          } else {
            config.plugins!.entries!.brave!.enabled = false;
          }
          activate(config);
        }
      } finally {
        release.resolve();
      }
      try {
        const settled = await outcome;
        expect(requests).toEqual([]);
        expect(settled).toHaveProperty("error");
      } finally {
        admission.close();
      }
    },
  );
});
