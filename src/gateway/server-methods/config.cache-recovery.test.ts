import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { invalidateConfigGetResponseCache } from "../config-get-response.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  readForWrite: vi.fn(),
  commit: vi.fn(),
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.read,
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotForWrite: mocks.readForWrite,
}));
vi.mock("./config-write-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-write-flow.js")>()),
  commitGatewayConfigWrite: mocks.commit,
  resolveGatewayConfigRestartWriteResult: async () => ({
    payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
    sentinelPersisted: false,
    restart: undefined,
  }),
}));
vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: async ({ config }: { config: OpenClawConfig }) => ({ config }),
}));
vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({ schema: {}, uiHints: undefined }),
}));

let storedConfig: OpenClawConfig;
let storedHash: string;
function readSnapshot() {
  const result = createConfigWriteSnapshot(storedConfig);
  result.snapshot.hash = storedHash;
  return result;
}
function externalEdit() {
  storedConfig = { logging: { level: "warn" } };
  storedHash = "external-hash";
}
beforeEach(() => {
  invalidateConfigGetResponseCache();
  storedConfig = { logging: { level: "info" } };
  storedHash = "base-hash";
  mocks.read.mockImplementation(async () => readSnapshot().snapshot);
  mocks.readForWrite.mockImplementation(async () => readSnapshot());
  mocks.commit.mockImplementation(
    async ({
      snapshot,
      nextConfig,
    }: {
      snapshot: { hash: string };
      nextConfig: OpenClawConfig;
    }) => {
      if (snapshot.hash !== storedHash) {
        throw new ConfigMutationConflictError("config changed since last load");
      }
      storedConfig = nextConfig;
      storedHash = "saved-hash";
      return {
        path: "/tmp/openclaw.json",
        config: storedConfig,
        hash: storedHash,
        queueFollowUp: vi.fn(),
      };
    },
  );
});
afterEach(() => {
  invalidateConfigGetResponseCache();
  vi.clearAllMocks();
});

it.each(
  (["config.patch", "config.set", "config.apply"] as const).flatMap((method) =>
    (["before request", "during commit"] as const).map((editAt) => ({ method, editAt })),
  ),
)(
  "$method reloads a rejected draft when an external edit occurs $editAt",
  async ({ method, editAt }) => {
    // Exercise the real response cache before watcher notification reaches the Gateway.
    const reader = createConfigHandlerHarness({
      contextOverrides: { getConfigReloaderHotReloadStatus: () => "active" },
    });
    const get = expectDefined(configHandlers["config.get"], "registered config.get");
    await get(reader.options);
    expect(reader.respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ hash: "base-hash", config: { logging: { level: "info" } } }),
      undefined,
    );
    if (editAt === "before request") {
      externalEdit();
    } else {
      mocks.commit.mockImplementationOnce(async () => {
        externalEdit();
        throw new ConfigMutationConflictError("config changed since last load");
      });
    }
    const writer = createConfigHandlerHarness({
      method,
      params: { raw: '{"logging":{"level":"debug"}}', baseHash: "base-hash" },
      contextOverrides: reader.options.context,
    });
    const write = expectDefined(configHandlers[method], "registered config write");
    await write(writer.options);
    expect(writer.respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("re-run config.get and retry") }),
    );
    expect(storedConfig).toEqual({ logging: { level: "warn" } });

    await get(reader.options);
    expect(reader.respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ hash: "external-hash", config: { logging: { level: "warn" } } }),
      undefined,
    );
    writer.options.params = { raw: '{"logging":{"level":"debug"}}', baseHash: "external-hash" };
    await write(writer.options);
    expect(writer.respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ hash: "saved-hash", config: { logging: { level: "debug" } } }),
      undefined,
    );
    expect(storedConfig).toEqual({ logging: { level: "debug" } });
  },
);
