// Shared command validation must emit one complete failure before terminating JSON commands.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyResolvedCommandOutputMode,
  withConsoleLogsRoutedToStderrForJson,
} from "../cli/json-output-mode.js";
import {
  requireValidConfig,
  requireValidConfigFileSnapshot,
  requireValidConfigForWrite,
} from "./config-validation.js";

const reads = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  compatibility: vi.fn(() => []),
}));
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: reads.read,
  readConfigFileSnapshotForWrite: reads.write,
}));
vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilitySnapshotNotices: reads.compatibility,
  formatPluginCompatibilityNotice: () => "unexpected compatibility notice",
}));

const configPath = "/synthetic/openclaw.json";
function invalidSnapshot() {
  return {
    path: configPath,
    exists: true,
    valid: false,
    raw: "{}",
    parsed: {},
    sourceConfig: {},
    config: {},
    issues: [{ path: "gateway.mode", message: "Invalid mode", allowedValues: ["local", "remote"] }],
    warnings: [],
    legacyIssues: [],
  };
}
function runtime() {
  const documents: unknown[] = [];
  return {
    documents,
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn((value: unknown) => {
      documents.push(structuredClone(value));
    }),
  };
}
async function withOutputMode<T>(json: boolean, run: () => Promise<T>) {
  return withConsoleLogsRoutedToStderrForJson(
    ["node", "openclaw", "agents", "list", "--json"],
    async () => {
      applyResolvedCommandOutputMode(json);
      return await run();
    },
    { restoreChanges: true },
  );
}
function expectedFailure() {
  return {
    ok: false,
    error: { type: "cli_error", message: `OpenClaw config is invalid: ${configPath}` },
    issues: [{ path: "gateway.mode", message: "Invalid mode", allowedValues: ["local", "remote"] }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reads.read.mockResolvedValue(invalidSnapshot());
  reads.write.mockResolvedValue({ snapshot: invalidSnapshot(), writeOptions: {} });
});
afterEach(() => vi.restoreAllMocks());

describe("command invalid-config JSON", () => {
  it("writes one enriched JSON failure before exit and no human diagnostic", async () => {
    const rt = runtime();
    const order: string[] = [];
    rt.writeJson.mockImplementation((value) => {
      rt.documents.push(value);
      order.push("json");
    });
    rt.exit.mockImplementation(() => {
      order.push("exit");
    });
    const result = await withOutputMode(true, () =>
      requireValidConfig(rt, { includeCompatibilityAdvisory: true }),
    );
    expect(result).toBeNull();
    expect(rt.documents).toEqual([expectedFailure()]);
    expect(order).toEqual(["json", "exit"]);
    expect(rt.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(rt.log).not.toHaveBeenCalled();
    expect(rt.error).not.toHaveBeenCalled();
    expect(reads.compatibility).not.toHaveBeenCalled();
  });

  it("does not return a writable snapshot when asynchronous validation fails", async () => {
    const rt = runtime();
    expect(await withOutputMode(true, () => requireValidConfigForWrite(rt))).toBeNull();
    expect(rt.documents).toEqual([expectedFailure()]);
    expect(rt.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(reads.read).not.toHaveBeenCalled();
  });

  it("preserves the native write snapshot identity on valid config", async () => {
    const read = {
      snapshot: { ...invalidSnapshot(), valid: true },
      writeOptions: { expectedConfigPath: configPath },
    };
    reads.write.mockResolvedValue(read);
    const rt = runtime();
    expect(await withOutputMode(true, () => requireValidConfigForWrite(rt))).toBe(read);
    expect(rt.documents).toEqual([]);
    expect(rt.exit).not.toHaveBeenCalled();
  });

  it("returns valid config without writing any failure document", async () => {
    const snapshot = { ...invalidSnapshot(), valid: true, config: { plugins: {} } };
    reads.read.mockResolvedValue(snapshot);
    const rt = runtime();
    expect(await withOutputMode(true, () => requireValidConfigFileSnapshot(rt))).toBe(snapshot);
    expect(rt.documents).toEqual([]);
    expect(rt.exit).not.toHaveBeenCalled();
  });

  it("retains the missing-file behavior", async () => {
    const snapshot = { ...invalidSnapshot(), exists: false };
    reads.read.mockResolvedValue(snapshot);
    const rt = runtime();
    expect(await withOutputMode(true, () => requireValidConfig(rt))).toEqual({});
    expect(rt.documents).toEqual([]);
    expect(rt.exit).not.toHaveBeenCalled();
  });

  it("keeps the existing human recovery and inspection guidance", async () => {
    const rt = runtime();
    expect(await withOutputMode(false, () => requireValidConfig(rt))).toBeNull();
    expect(rt.error).toHaveBeenCalledWith("Fix: openclaw doctor --fix");
    expect(rt.error).toHaveBeenCalledWith("Inspect: openclaw config validate");
    expect(rt.documents).toEqual([]);
    expect(rt.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("retains normalized root issues and nonempty allowed-value metadata", async () => {
    reads.read.mockResolvedValue({
      ...invalidSnapshot(),
      issues: [
        { path: " ", message: "Invalid root", allowedValues: [] },
        {
          path: "mode",
          message: "Choose a mode",
          allowedValues: ["local"],
          allowedValuesHiddenCount: 2,
        },
      ],
    });
    const rt = runtime();
    await withOutputMode(true, () => requireValidConfig(rt));
    expect(rt.documents).toEqual([
      {
        ...expectedFailure(),
        issues: [
          { path: "<root>", message: "Invalid root" },
          {
            path: "mode",
            message: "Choose a mode",
            allowedValues: ["local"],
            allowedValuesHiddenCount: 2,
          },
        ],
      },
    ]);
  });

  it("emits an empty issues array when no issue details are available", async () => {
    reads.read.mockResolvedValue({ ...invalidSnapshot(), issues: [] });
    const rt = runtime();
    await withOutputMode(true, () => requireValidConfig(rt));
    expect(rt.documents).toEqual([{ ...expectedFailure(), issues: [] }]);
  });

  it("supports runtimes without an optional writeJson method", async () => {
    const rt = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await withOutputMode(true, () => requireValidConfig(rt));
    expect(rt.log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(rt.log.mock.calls[0]?.[0]))).toEqual(expectedFailure());
    expect(rt.error).not.toHaveBeenCalled();
  });

  it("propagates a snapshot read failure without fabricating config issues", async () => {
    const failure = new Error("snapshot unavailable");
    reads.read.mockRejectedValueOnce(failure);
    const rt = runtime();
    await expect(withOutputMode(true, () => requireValidConfig(rt))).rejects.toBe(failure);
    expect(rt.documents).toEqual([]);
    expect(rt.exit).not.toHaveBeenCalled();
  });

  it("does not report success when the JSON writer fails", async () => {
    const failure = new Error("output unavailable");
    const rt = runtime();
    rt.writeJson.mockImplementation(() => {
      throw failure;
    });
    await expect(withOutputMode(true, () => requireValidConfig(rt))).rejects.toBe(failure);
    expect(rt.exit).not.toHaveBeenCalled();
  });

  it("preserves explicit read options", async () => {
    const rt = runtime();
    await withOutputMode(true, () =>
      requireValidConfig(rt, { observe: false, skipPluginValidation: true }),
    );
    expect(reads.read).toHaveBeenCalledExactlyOnceWith({
      observe: false,
      skipPluginValidation: true,
    });
  });
});
