import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import {
  forceFreePort,
  listPortListeners,
  parseLsofOutput,
  type PortProcess,
} from "./program.js";

describe("gateway --force helpers", () => {
  let originalKill: typeof process.kill;

  beforeEach(() => {
    vi.clearAllMocks();
    originalKill = process.kill;
  });

  afterEach(() => {
    process.kill = originalKill;
  });

  it("parses lsof output into pid/command pairs", () => {
    const sample = ["p123", "cnode", "p456", "cpython", ""].join("\n");
    const parsed = parseLsofOutput(sample);
    expect(parsed).toEqual<PortProcess[]>([
      { pid: 123, command: "node" },
      { pid: 456, command: "python" },
    ]);
  });

  it("returns empty list when lsof finds nothing", () => {
    (execFileSync as unknown as vi.Mock).mockImplementation(() => {
      const err = new Error("no matches");
      // @ts-expect-error partial
      err.status = 1; // lsof uses exit 1 for no matches
      throw err;
    });
    expect(listPortListeners(18789)).toEqual([]);
  });

  it("throws when lsof missing", () => {
    (execFileSync as unknown as vi.Mock).mockImplementation(() => {
      const err = new Error("not found");
      // @ts-expect-error partial
      err.code = "ENOENT";
      throw err;
    });
    expect(() => listPortListeners(18789)).toThrow(/lsof not found/);
  });

  it("kills each listener and returns metadata", () => {
    (execFileSync as unknown as vi.Mock).mockReturnValue(
      ["p42", "cnode", "p99", "cssh", ""].join("\n"),
    );
    const killMock = vi.fn();
    // @ts-expect-error override for test
    process.kill = killMock;

    const killed = forceFreePort(18789);

    expect(execFileSync).toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledTimes(2);
    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(99, "SIGTERM");
    expect(killed).toEqual<PortProcess[]>([
      { pid: 42, command: "node" },
      { pid: 99, command: "ssh" },
    ]);
  });
});
