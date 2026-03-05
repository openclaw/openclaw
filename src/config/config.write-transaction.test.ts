import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./types.openclaw.js";

const mocks = vi.hoisted(() => ({
  runConfigWriteTransaction: vi.fn(),
}));

vi.mock("./io.js", () => ({
  clearConfigCache: vi.fn(),
  clearRuntimeConfigSnapshot: vi.fn(),
  createConfigIO: vi.fn(),
  getRuntimeConfigSnapshot: vi.fn(),
  loadConfig: vi.fn(),
  parseConfigJson5: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  resolveConfigSnapshotHash: vi.fn(),
  setRuntimeConfigSnapshot: vi.fn(),
}));

vi.mock("./transaction.js", () => ({
  runConfigWriteTransaction: (...args: unknown[]) => mocks.runConfigWriteTransaction(...args),
  recoverConfigFromBackups: vi.fn(),
}));

import { writeConfigFile } from "./config.js";

describe("config.writeConfigFile", () => {
  beforeEach(() => {
    mocks.runConfigWriteTransaction.mockReset();
  });

  it("delegates writes to transaction pipeline", async () => {
    mocks.runConfigWriteTransaction.mockResolvedValue({
      ok: true,
      transactionId: "tx-1",
      stage: null,
      rolledBack: false,
      beforeHash: "before",
      afterHash: "after",
    });
    const cfg = { gateway: { mode: "local" } } as OpenClawConfig;
    const options = { unsetPaths: [["gateway", "bind"]] };

    await expect(writeConfigFile(cfg, options)).resolves.toBeUndefined();
    expect(mocks.runConfigWriteTransaction).toHaveBeenCalledWith({
      config: cfg,
      writeOptions: options,
    });
  });

  it("throws detailed errors when transaction fails", async () => {
    mocks.runConfigWriteTransaction.mockResolvedValue({
      ok: false,
      transactionId: "tx-2",
      stage: "verify",
      rolledBack: true,
      beforeHash: "before",
      afterHash: "after",
      error: "committed config failed verification",
    });
    const cfg = { gateway: { mode: "local" } } as OpenClawConfig;

    await expect(writeConfigFile(cfg)).rejects.toThrow(
      "writeConfigFile transaction failed; stage=verify; rollback=ok; committed config failed verification",
    );
  });
});
