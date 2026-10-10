import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../config/config.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { installGatewayTestHooks, rpcReq, startConnectedServerWithClient } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type ConnectedGateway = Awaited<ReturnType<typeof startConnectedServerWithClient>>;

let gateway: ConnectedGateway | undefined;
let minimalGatewayEnv: ReturnType<typeof captureEnv> | undefined;

function requireGateway(): ConnectedGateway {
  if (!gateway) {
    throw new Error("chat metadata Gateway is not ready");
  }
  return gateway;
}

beforeAll(async () => {
  minimalGatewayEnv = captureEnv(["OPENCLAW_TEST_MINIMAL_GATEWAY"]);
  // The production lifecycle has no refresh-on-read escape hatch. This must stay non-minimal,
  // otherwise the old sticky behavior is hidden by the test-only lifecycle configuration.
  setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
  await writeGatewayConfig(CHAT_METADATA_BOUNDARY_CONFIG);
  gateway = await startConnectedServerWithClient();
  await gateway.server.startupSettled;
}, 60_000);

beforeEach(async () => {
  setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
  await writeGatewayConfig(CHAT_METADATA_BOUNDARY_CONFIG);
  const { refreshPreparedModelRuntimeSnapshots } =
    await import("../agents/prepared-model-runtime.js");
  await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), { gatewayLifecycle: true });
  const ready = await rpcReq(requireGateway().ws, "chat.metadata", { agentId: "main" });
  expect(ready.ok, JSON.stringify(ready)).toBe(true);
});

afterAll(async () => {
  if (gateway) {
    gateway.ws.close();
    await gateway.server.close();
    gateway.envSnapshot.restore();
  }
  clearConfigCache();
  minimalGatewayEnv?.restore();
});

const CHAT_METADATA_BOUNDARY_CONFIG = {
  agents: {
    ownership: "explicit",
    defaults: {
      systemAgent: { agentId: "main" },
      model: { primary: "openai/gpt-boundary" },
      models: { "openai/gpt-boundary": {} },
    },
    entries: { main: {}, healthy: {} },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://openai.example.com/v1",
        models: [{ id: "gpt-boundary", name: "GPT Boundary" }],
      },
    },
  },
} as const;

const CHAT_METADATA_MISSING_OWNER_CONFIG = {
  ...CHAT_METADATA_BOUNDARY_CONFIG,
  agents: {
    ...CHAT_METADATA_BOUNDARY_CONFIG.agents,
    entries: {
      ...CHAT_METADATA_BOUNDARY_CONFIG.agents.entries,
      missing: {},
    },
  },
} as const;

async function writeGatewayConfig(
  config: Record<string, unknown>,
  options: { clearRuntimeSnapshot?: boolean } = {},
) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  clearConfigCache();
  if (options.clearRuntimeSnapshot) {
    clearRuntimeConfigSnapshot();
  }
}

test("chat.metadata preserves deferred admission while isolating projection and owner publication failures", async () => {
  const ws = requireGateway().ws;
  const publicationEvents = await import("../agents/prepared-model-runtime.publication-events.js");
  const initial = await rpcReq(ws, "chat.metadata", { agentId: "main" });
  expect(initial.ok).toBe(true);

  // This is the lifecycle listener's real published catch-up. Config can expose an agent before
  // its prepared owner exists, reproducing the stale publication announcement that wedged UI.
  await writeGatewayConfig(CHAT_METADATA_MISSING_OWNER_CONFIG, { clearRuntimeSnapshot: true });
  publicationEvents.notifyPreparedModelRuntimePublication({ phase: "published" });
  let unavailable: Awaited<ReturnType<typeof rpcReq>> | undefined;
  await vi.waitFor(
    async () => {
      unavailable = await rpcReq(ws, "chat.metadata", { agentId: "main" });
      expect(unavailable.ok).toBe(false);
    },
    { interval: 1, timeout: 2_000 },
  );
  expect(unavailable).toMatchObject({
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: expect.stringContaining("prepared chat metadata owner is unavailable"),
    },
  });

  await writeGatewayConfig(CHAT_METADATA_BOUNDARY_CONFIG, { clearRuntimeSnapshot: true });
  const recovered = await rpcReq<{
    models?: Array<{ id?: string; provider?: string }>;
  }>(ws, "chat.metadata", { agentId: "main" });

  expect(recovered.ok).toBe(true);
  expect(recovered.payload?.models).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "gpt-boundary", provider: "openai" })]),
  );

  // Reset the published runtime between boundary cases without restarting the Gateway.
  const { refreshPreparedModelRuntimeSnapshots } =
    await import("../agents/prepared-model-runtime.js");
  await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), { gatewayLifecycle: true });
  const reset = await rpcReq(ws, "chat.metadata", { agentId: "main" });
  expect(reset.ok).toBe(true);

  const modelsListResult = await import("./server-methods/models-list-result.js");
  const prepareModelsListResult = modelsListResult.prepareModelsListResult;
  const projectionFailure = new Error("configured model catalog unavailable");
  const projectionSpy = vi
    .spyOn(modelsListResult, "prepareModelsListResult")
    .mockImplementation(async (params) => {
      if (params.agentId === "main") {
        throw projectionFailure;
      }
      return prepareModelsListResult(params);
    });

  publicationEvents.notifyPreparedModelRuntimePublication({ phase: "invalidated" });
  publicationEvents.notifyPreparedModelRuntimePublication({ phase: "published" });
  const projectionUnavailable = await rpcReq(ws, "chat.metadata", { agentId: "main" });
  expect(projectionUnavailable).toMatchObject({
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: expect.stringContaining("configured model catalog unavailable"),
    },
  });
  const healthy = await rpcReq(ws, "chat.metadata", { agentId: "healthy" });
  expect(healthy.ok, JSON.stringify(healthy)).toBe(true);

  projectionSpy.mockRestore();
  const projectionRecovered = await rpcReq(ws, "chat.metadata", { agentId: "main" });
  expect(projectionRecovered.ok, JSON.stringify(projectionRecovered)).toBe(true);

  await assertDeferredAdmissionMetadata();

  publicationEvents.notifyPreparedModelRuntimePublication({ phase: "invalidated" });
  publicationEvents.notifyPreparedModelRuntimePublication({
    phase: "failed",
    error: new Error("prepared model owner publication failed"),
  });
  for (const agentId of ["main", "healthy"]) {
    expect(await rpcReq(ws, "chat.metadata", { agentId })).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("prepared model owner publication failed"),
      },
    });
  }
});

async function assertDeferredAdmissionMetadata() {
  const {
    createAgentDatabaseInspectionRefusal,
    preparePendingAgentDatabase,
    recordAgentDatabaseAdmissions,
  } = await import("../state/agent-database-admission.js");
  const { resolveOpenClawAgentSqlitePath } = await import("../state/openclaw-agent-db.paths.js");
  const { refreshPreparedModelRuntimeSnapshots } =
    await import("../agents/prepared-model-runtime.js");
  const { notifyPreparedModelRuntimePublication } =
    await import("../agents/prepared-model-runtime.publication-events.js");
  const { ws } = requireGateway();
  const env = { ...process.env };
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "main",
    paths: [resolveOpenClawAgentSqlitePath({ agentId: "main", env })],
    pending: true,
    reason: "Synthetic deferred startup admission",
  });
  const releasePublication = createDeferred();
  let latePublication: Promise<void> | undefined;
  recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
  try {
    await preparePendingAgentDatabase(refusal, { env, assertCurrent() {} }, async () => {
      await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), {
        agentIds: new Set(["main"]),
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
      });
      // Catalog completion retains the publisher's borrow after admission has settled.
      latePublication = releasePublication.promise.then(() => {
        notifyPreparedModelRuntimePublication({
          phase: "catalog-published",
          modelFactsChanged: false,
          refreshStatusChanged: true,
        });
      });
    });
    const admitted = await rpcReq(ws, "chat.metadata", { agentId: "main" });
    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
    releasePublication.resolve();
    await latePublication;
    for (const [method, params] of [
      ["chat.metadata", { agentId: "main" }],
      ["models.list", { agentId: "main", view: "configured", preparedOnly: true }],
    ] as const) {
      const result = await rpcReq<{ models?: Array<{ id?: string; provider?: string }> }>(
        ws,
        method,
        params,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.payload?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "gpt-boundary", provider: "openai" }),
        ]),
      );
    }
  } finally {
    releasePublication.resolve();
    await latePublication;
    recordAgentDatabaseAdmissions([], { env, source: "startup" });
  }
}
