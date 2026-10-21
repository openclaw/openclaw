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
vi.mock("../../config/runtime-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-schema.js")>()),
  loadGatewayConfigRedactionHints: () => undefined,
  loadGatewayRuntimeConfigSchema: () => ({ schema: {}, uiHints: undefined }),
}));

let storedConfig: OpenClawConfig;
let storedHash: string;
type Harness = ReturnType<typeof createConfigHandlerHarness>;
function readSnapshot() {
  const result = createConfigWriteSnapshot(storedConfig);
  result.snapshot.hash = storedHash;
  return result;
}
function externalEdit() {
  storedConfig = { logging: { level: "warn" } };
  storedHash = "external-hash";
}
function expectConfig({ respond }: Harness, hash: string, level: string) {
  expect(respond).toHaveBeenLastCalledWith(
    true,
    expect.objectContaining({ hash, config: { logging: { level } } }),
    undefined,
  );
}

beforeEach(() => {
  invalidateConfigGetResponseCache();
  storedConfig = { logging: { level: "info" } };
  storedHash = "base-hash";
  mocks.read.mockImplementation(async () => readSnapshot().snapshot);
  mocks.readForWrite.mockImplementation(async () => readSnapshot());
  mocks.commit.mockImplementation(
    async (input: { snapshot: { hash: string }; nextConfig: OpenClawConfig }) => {
      if (input.snapshot.hash !== storedHash) {
        throw new ConfigMutationConflictError("config changed since last load");
      }
      storedConfig = input.nextConfig;
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

it.each(["before request", "during commit"])(
  "config.patch reloads a rejected draft when an external edit occurs %s",
  async (editAt) => {
    // Exercise the real response cache before watcher notification reaches the Gateway.
    const reader = createConfigHandlerHarness({
      contextOverrides: { getConfigReloaderHotReloadStatus: () => "active" },
    });
    const get = expectDefined(configHandlers["config.get"], "registered config.get");
    await get(reader.options);
    expectConfig(reader, "base-hash", "info");
    if (editAt === "before request") {
      externalEdit();
    } else {
      mocks.commit.mockImplementationOnce(async () => {
        externalEdit();
        throw new ConfigMutationConflictError("config changed since last load");
      });
    }
    const writer = createConfigHandlerHarness({
      method: "config.patch",
      params: { raw: '{"logging":{"level":"debug"}}', baseHash: "base-hash" },
      contextOverrides: reader.options.context,
    });
    const write = expectDefined(configHandlers["config.patch"], "registered config write");
    await write(writer.options);
    expect(writer.respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("re-run config.get and retry") }),
    );
    expect(storedConfig).toEqual({ logging: { level: "warn" } });

    await get(reader.options);
    expectConfig(reader, "external-hash", "warn");
    writer.options.params = { raw: '{"logging":{"level":"debug"}}', baseHash: "external-hash" };
    await write(writer.options);
    expectConfig(writer, "saved-hash", "debug");
    expect(storedConfig).toEqual({ logging: { level: "debug" } });
  },
);
