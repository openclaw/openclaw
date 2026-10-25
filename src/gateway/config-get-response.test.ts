import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { makeSnapshot } from "../config/redact-snapshot.test-helpers.js";
import { invalidateGatewayRuntimeConfigSchema } from "../config/runtime-schema.js";
import * as schema from "../config/schema.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({
  pluginRegistryVersion: 1,
  config: {} as OpenClawConfig,
  snapshot: vi.fn<() => Promise<ConfigFileSnapshot>>(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.snapshot,
  getRuntimeConfig: () => mocks.config,
}));

vi.mock("../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/runtime-snapshot.js")>()),
  getRuntimeConfigAppliedHash: () => "applied-1",
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistryVersion: () => mocks.pluginRegistryVersion,
}));

const { invalidateConfigGetResponseCache, readConfigGetResponse: readResponseImpl } =
  await import("./config-get-response.js");

const revisionProjector = {
  projectRawHash: (hash: string) => `raw-token:${hash}`,
  projectResolvedHash: (hash: string) => `resolved-token:${hash}`,
  hashResponseSessionBearer: () => "unused-test-scope",
};

function readResponse(params: Omit<Parameters<typeof readResponseImpl>[0], "revisionProjector">) {
  return readResponseImpl({ ...params, revisionProjector });
}

const activeWatcher = () => "active" as const;
const disabledWatcher = () => "disabled" as const;
const readWatched = () => readResponse({ getHotReloadStatus: activeWatcher });

function setPlugins(
  plugins: NonNullable<Parameters<typeof createPluginMetadataSnapshotFixture>[0]>["plugins"],
) {
  setGatewayPluginMetadataSnapshot(createPluginMetadataSnapshotFixture({ plugins }));
}

function objectSchema(properties: Record<string, unknown>, $defs?: Record<string, unknown>) {
  return { type: "object", properties, ...($defs ? { $defs } : {}) };
}

beforeEach(() => {
  invalidateConfigGetResponseCache();
  mocks.pluginRegistryVersion = 1;
  mocks.config = {};
  invalidateGatewayRuntimeConfigSchema();
  setGatewayPluginMetadataSnapshot(createPluginMetadataSnapshotFixture({ plugins: [] }));
  mocks.snapshot.mockReset().mockResolvedValue(makeSnapshot({ gateway: { port: 19_001 } }));
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCurrentPluginMetadataSnapshot();
  invalidateGatewayRuntimeConfigSchema();
});

it("redacts cold core/plugin config without a form schema and preserves SecretRef identity", async () => {
  const secretRef = { source: "store" as const, provider: "default", id: "TEST_SECRET" };
  const plaintext = "synthetic-plugin-secret";
  const routes = {
    publish: { sessionKey: "agent:main", secret: secretRef },
    deploy: { sessionKey: "agent:main", secret: secretRef },
    plain: { sessionKey: "agent:main", secret: plaintext },
  };
  const config: OpenClawConfig = {
    gateway: { auth: { token: "synthetic-cold-token-canary" } },
    plugins: { entries: { webhooks: { enabled: true, config: { routes } } } },
  };
  const buildSchema = vi.spyOn(schema, "buildConfigSchemaCore");
  setPlugins([
    {
      id: "webhooks",
      origin: "bundled",
      configContracts: {
        secretInputs: {
          paths: [{ path: "routes.*.secret", expected: "string", ownerKind: "route" }],
        },
      },
      configSchema: objectSchema(
        {
          routes: { type: "object", additionalProperties: { $ref: "#/$defs/route" } },
        },
        {
          route: objectSchema({ secret: { anyOf: [{ type: "string" }, { type: "object" }] } }),
        },
      ),
    },
  ]);
  mocks.config = config;

  mocks.snapshot.mockResolvedValue(makeSnapshot(config));
  const response = await readResponse({});
  expect(response.config.gateway?.auth?.token).toBe(REDACTED_SENTINEL);
  expect(JSON.stringify(response)).not.toContain("synthetic-cold-token-canary");
  expect(buildSchema).not.toHaveBeenCalled();
  const redactedSecret = { ...secretRef, id: REDACTED_SENTINEL };
  expect(response.config.plugins?.entries?.webhooks?.config).toMatchObject({
    routes: {
      publish: { secret: redactedSecret },
      deploy: { secret: redactedSecret },
      plain: { secret: REDACTED_SENTINEL },
    },
  });
  expect(JSON.stringify(response)).not.toContain(plaintext);
  expect(JSON.stringify(response)).not.toContain(secretRef.id);
});

it("shares one concurrent projection and serves cache hits without filesystem work", async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => readWatched()));
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  const [first] = responses;
  expect(responses.every((response) => response === first)).toBe(true);
  const stat = vi.spyOn(fs.promises, "stat");
  mocks.snapshot.mockClear();

  const hit = await readWatched();

  expect(hit).toBe(first);
  expect(stat).not.toHaveBeenCalled();
  expect(mocks.snapshot).not.toHaveBeenCalled();

  invalidateConfigGetResponseCache();
  const fresh = await readWatched();
  expect(hit).toEqual(fresh);
  await expect(readResponse({ getHotReloadStatus: disabledWatcher })).resolves.toEqual(fresh);
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
});

it.each(["read failure", "metadata generation"])("rebuilds after %s", async (reason) => {
  if (reason === "read failure") {
    mocks.snapshot.mockRejectedValueOnce(new Error("transient read failure"));
    await expect(readWatched()).rejects.toThrow("transient read failure");
  } else {
    await readWatched();
    mocks.pluginRegistryVersion = 2;
  }
  await expect(readWatched()).resolves.toMatchObject({
    appliedConfigHash: "resolved-token:applied-1",
  });
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
});
