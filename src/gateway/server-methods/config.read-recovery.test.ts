import { writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ConfigWritePostCommitError } from "../../config/io.write-errors.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { invalidateConfigGetResponseCache, readConfigGetResponse } from "../config-get-response.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

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
const dirs = createTempDirTracker();
afterEach(dirs.cleanup);

it.each([
  { exists: false, valid: true, backup: true },
  { exists: true, valid: false, backup: true },
  { exists: false, valid: true, backup: false },
  { exists: true, valid: false, backup: false },
  { exists: true, valid: true, backup: true },
  { exists: true, valid: true, backup: false },
])(
  "config.get preserves diagnostics without inferring rollback from a backup: %j",
  async ({ exists, valid, backup }) => {
    const configPath = path.join(dirs.make("config-read-recovery-"), "openclaw.json");
    const recoveryBackupPath = `${configPath}.bak`;
    if (backup) {
      writeFileSync(recoveryBackupPath, '{"gateway":{"mode":"local"}}');
    }
    const snapshot = {
      ...createConfigWriteSnapshot({}).snapshot,
      path: configPath,
      exists,
      valid,
      issues: valid ? [] : [{ path: "gateway.port", message: "Expected number, received string" }],
      configRevisionHash: "revision",
      appliedConfigHash: null,
    };
    vi.mocked(readConfigGetResponse).mockResolvedValue(snapshot);
    const { options, respond } = createConfigHandlerHarness({ method: "config.get" });
    await expectDefined(configHandlers["config.get"], "registered config.get")(options);
    expect(respond).toHaveBeenCalledWith(true, snapshot, undefined);
  },
);

it("config.get keeps recorded publication failure across an older read and reconciles a fresh valid read", async () => {
  const writeHarness = createConfigHandlerHarness({
    method: "config.set",
    params: { raw: "{}", baseHash: "base-hash" },
  });
  const getHarness = () =>
    createConfigHandlerHarness({
      method: "config.get",
      contextOverrides: {
        configRevisionProjector: writeHarness.options.context.configRevisionProjector,
      },
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
  write.mockRejectedValueOnce(
    new ConfigWritePostCommitError({
      configPath: valid.path,
      publication: "partial",
      rollbackStatus: "unknown",
      cause: new Error("injected restoration failure"),
    }),
  );
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
  for (const snapshot of [{ ...valid, exists: false, raw: null }, invalid]) {
    vi.mocked(readConfigGetResponse).mockResolvedValueOnce(snapshot);
    const reader = getHarness();
    await get(reader.options);
    expect(reader.respond).toHaveBeenCalledWith(true, { ...snapshot, writeError }, undefined);
  }
  vi.mocked(readConfigGetResponse).mockResolvedValueOnce(valid);
  const restored = getHarness();
  await get(restored.options);
  expect(restored.respond).toHaveBeenCalledWith(true, valid, undefined);
  vi.mocked(readConfigGetResponse).mockResolvedValueOnce(invalid);
  const laterInvalid = getHarness();
  await get(laterInvalid.options);
  expect(laterInvalid.respond).toHaveBeenCalledWith(true, invalid, undefined);
});
