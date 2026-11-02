import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { ConfigWritePostCommitError } from "../../config/io.write-errors.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { invalidateConfigGetResponseCache, readConfigGetResponse } from "../config-get-response.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

const write = vi.hoisted(() => vi.fn());
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotForWrite: async () => createConfigWriteSnapshot({}),
}));
vi.mock("./config-write-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-write-flow.js")>()),
  commitGatewayConfigWrite: write,
}));
vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: async ({ config }: { config: OpenClawConfig }) => ({ config }),
}));
vi.mock("../config-get-response.js", () => ({
  readConfigGetResponse: vi.fn(),
  invalidateConfigGetResponseCache: vi.fn(),
}));

function publicationFailure(rollbackStatus: "unknown" | "restored" | "not-restored") {
  return new ConfigWritePostCommitError({
    configPath: "/tmp/openclaw.json",
    publication: "partial",
    rollbackStatus,
    cause: new Error("synthetic publication failure"),
  });
}

function patchHarness(baseHash = "base-hash") {
  return createConfigHandlerHarness({
    method: "config.patch",
    params: { raw: '{"hooks":{"enabled":true}}', baseHash },
  });
}

type Harness = ReturnType<typeof createConfigHandlerHarness>;
function expectUnavailable({ respond }: Harness, details: unknown) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({ code: "UNAVAILABLE", details }),
  );
}

it("config.get keeps recorded publication failure across an older read and reconciles a fresh valid read", async () => {
  const writeHarness = createConfigHandlerHarness({
    method: "config.set",
    params: { raw: "{}", baseHash: "base-hash" },
  });
  const getHarness = () =>
    createConfigHandlerHarness({
      contextOverrides: writeHarness.options.context,
    });
  const valid = {
    ...createConfigWriteSnapshot({}).snapshot,
    configRevisionHash: "revision",
    appliedConfigHash: null,
  };
  const readBeforeFailure = createDeferred<typeof valid>();
  vi.mocked(readConfigGetResponse).mockReturnValueOnce(readBeforeFailure.promise);
  const oldRead = getHarness();
  const get = expectDefined(configHandlers["config.get"], "registered config.get");
  const pendingRead = get(oldRead.options);
  write.mockRejectedValueOnce(publicationFailure("unknown"));
  await expectDefined(configHandlers["config.set"], "registered config.set")(writeHarness.options);
  expect(writeHarness.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "UNAVAILABLE" }),
  );
  expect(invalidateConfigGetResponseCache).toHaveBeenCalled();
  const writeError = expect.objectContaining({
    code: "UNAVAILABLE",
    details: {
      publication: "partial",
      rollbackStatus: "unknown",
      configPath: valid.path,
      recoveryBackupPath: `${valid.path}.bak`,
    },
  });
  readBeforeFailure.resolve(valid);
  await pendingRead;
  expect(oldRead.respond).toHaveBeenCalledWith(true, { ...valid, writeError }, undefined);

  const invalid = {
    ...valid,
    valid: false,
    issues: [{ path: "gateway.port", message: "Expected number, received string" }],
  };
  async function read(
    snapshot: Awaited<ReturnType<typeof readConfigGetResponse>>,
    expected: unknown,
  ) {
    vi.mocked(readConfigGetResponse).mockResolvedValueOnce(snapshot);
    const reader = getHarness();
    await get(reader.options);
    expect(reader.respond).toHaveBeenCalledWith(true, expected, undefined);
  }
  for (const snapshot of [{ ...valid, exists: false, raw: null }, invalid]) {
    await read(snapshot, { ...snapshot, writeError });
  }
  await read(valid, valid);
  await read(invalid, invalid);
});

it("reports only the committed config with a projected hash and redacted secrets after failed application", async () => {
  const committed = createDeferred();
  const application = createDeferred<"failed">();
  const queueFollowUp = vi.fn();
  write.mockImplementationOnce(async () => {
    committed.resolve();
    return {
      path: "/tmp/openclaw.json",
      config: {
        hooks: { enabled: true },
        gateway: { auth: { token: "synthetic-persisted-token" } },
      },
      hash: "committed-hash",
      application: application.promise,
      queueFollowUp,
    };
  });
  const harness = patchHarness("public:base-hash");
  harness.options.context.configRevisionProjector = {
    projectRawHash: (hash) => `public:${hash}`,
    projectResolvedHash: (hash) => hash,
    hashResponseSessionBearer: () => "unused-test-scope",
  };
  const operation = expectDefined(
    configHandlers["config.patch"],
    "registered config.patch",
  )(harness.options);
  await committed.promise;
  expect(harness.respond).not.toHaveBeenCalled();
  application.resolve("failed");
  await operation;
  expectUnavailable(harness, {
    persistedConfig: {
      hash: "public:committed-hash",
      config: {
        hooks: { enabled: true },
        gateway: { auth: { token: "__OPENCLAW_REDACTED__" } },
      },
    },
  });
  expect(queueFollowUp).toHaveBeenCalledOnce();
});

it.each(["restored", "not-restored"] as const)(
  "does not report a committed receipt when publication rollback is %s",
  async (rollbackStatus) => {
    write.mockRejectedValueOnce(publicationFailure(rollbackStatus));
    const harness = patchHarness();
    await expectDefined(configHandlers["config.patch"], "registered config.patch")(harness.options);
    expectUnavailable(harness, expect.not.objectContaining({ persistedConfig: expect.anything() }));
  },
);
