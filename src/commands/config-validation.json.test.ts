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
}));
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: reads.read,
  readConfigFileSnapshotForWrite: reads.write,
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
    issues: [
      { path: " ", message: "Invalid root", allowedValues: [] },
      {
        path: "mode",
        message: "Choose a mode",
        allowedValues: ["local"],
        allowedValuesHiddenCount: 2,
      },
    ],
    warnings: [],
    legacyIssues: [],
  };
}
function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn<(value: unknown) => void>(),
  };
}
async function withJsonOutput<T>(run: () => Promise<T>) {
  return withConsoleLogsRoutedToStderrForJson(
    ["node", "openclaw", "agents", "list", "--json"],
    async () => {
      applyResolvedCommandOutputMode(true);
      return await run();
    },
    { restoreChanges: true },
  );
}
function expectedFailure() {
  return {
    ok: false,
    error: { type: "cli_error", message: `OpenClaw config is invalid: ${configPath}` },
    issues: [
      { path: "<root>", message: "Invalid root" },
      {
        path: "mode",
        message: "Choose a mode",
        allowedValues: ["local"],
        allowedValuesHiddenCount: 2,
      },
    ],
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
    rt.writeJson.mockImplementation(() => {
      order.push("json");
    });
    rt.exit.mockImplementation(() => {
      order.push("exit");
    });
    await expect(withJsonOutput(() => requireValidConfig(rt))).rejects.toMatchObject({
      name: "ExitError",
      code: 1,
    });
    expect(rt.writeJson).toHaveBeenCalledExactlyOnceWith(expectedFailure(), 2);
    expect(order).toEqual(["json", "exit"]);
    expect(rt.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(rt.log).not.toHaveBeenCalled();
    expect(rt.error).not.toHaveBeenCalled();
  });

  it("does not return a writable snapshot when asynchronous validation fails", async () => {
    reads.write.mockResolvedValue({
      snapshot: { ...invalidSnapshot(), issues: [] },
      writeOptions: {},
    });
    const rt = runtime();
    await expect(withJsonOutput(() => requireValidConfigForWrite(rt))).rejects.toMatchObject({
      name: "ExitError",
      code: 1,
    });
    expect(rt.writeJson).toHaveBeenCalledExactlyOnceWith({ ...expectedFailure(), issues: [] }, 2);
    expect(rt.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(reads.read).not.toHaveBeenCalled();
  });

  it("returns valid config without writing any failure document", async () => {
    const snapshot = { ...invalidSnapshot(), valid: true, config: { plugins: {} } };
    reads.read.mockResolvedValue(snapshot);
    const rt = runtime();
    expect(await withJsonOutput(() => requireValidConfigFileSnapshot(rt))).toBe(snapshot);
    expect(rt.writeJson).not.toHaveBeenCalled();
    expect(rt.exit).not.toHaveBeenCalled();
  });

  it("retains the missing-file behavior", async () => {
    const snapshot = { ...invalidSnapshot(), exists: false };
    reads.read.mockResolvedValue(snapshot);
    const rt = runtime();
    expect(await withJsonOutput(() => requireValidConfig(rt))).toEqual({});
    expect(rt.writeJson).not.toHaveBeenCalled();
    expect(rt.exit).not.toHaveBeenCalled();
  });

  it("propagates a snapshot read failure without fabricating config issues", async () => {
    const failure = new Error("snapshot unavailable");
    reads.read.mockRejectedValueOnce(failure);
    const rt = runtime();
    await expect(withJsonOutput(() => requireValidConfig(rt))).rejects.toBe(failure);
    expect(rt.writeJson).not.toHaveBeenCalled();
    expect(rt.exit).not.toHaveBeenCalled();
  });

  it("does not report success when the JSON writer fails", async () => {
    const failure = new Error("output unavailable");
    const rt = runtime();
    rt.writeJson.mockImplementation(() => {
      throw failure;
    });
    await expect(withJsonOutput(() => requireValidConfig(rt))).rejects.toBe(failure);
    expect(rt.exit).not.toHaveBeenCalled();
  });
});
