// Update definition admission must observe system ownership without loading a unit.
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "./exec-file.js";
const exec = vi.hoisted(() => vi.fn<typeof import("./exec-file.js").execFileUtf8>());
vi.mock("./exec-file.js", () => ({ execFileUtf8: exec }));
import { assertNoSystemSystemdOwnership } from "./systemd-system.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const unit = "openclaw-owned.service";
const owner = ":1.4";
const success = (type: string, data: unknown): ExecResult => ({
  code: 0,
  termination: "exit",
  stdout: JSON.stringify({ type, data }),
  stderr: "",
});
const missing = (): ExecResult => ({
  code: 1,
  termination: "exit",
  stdout: "",
  stderr: `Call failed: Unit ${unit} not loaded.`,
});
function reply(args: readonly string[]): ExecResult {
  if (args.includes("GetNameOwner")) {
    return success("s", [owner]);
  }
  if (args.includes("GetUnit")) {
    return missing();
  }
  if (args.includes("UnitPath")) {
    return success("as", ["/etc/systemd/system", "/run/systemd/system"]);
  }
  throw new Error("Unexpected manager query");
}
const absent = () => assertNoSystemSystemdOwnership(unit, 1000, { requireLoaded: true });
beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  vi.spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  exec.mockReset().mockImplementation(async (_command, args) => reply(args));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("non-loading system ownership", () => {
  it("proves absence using the existing manager and load paths without activation", async () => {
    await expect(absent()).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(5);
    expect(
      exec.mock.calls.every(
        ([command, args]) =>
          command === "busctl" &&
          args.includes("--system") &&
          args.includes("--auto-start=no") &&
          !args.includes("LoadUnit"),
      ),
    ).toBe(true);
    expect(
      exec.mock.calls
        .filter(([, args]) => !args.includes("GetNameOwner"))
        .every(([, args]) => args.includes(owner)),
    ).toBe(true);
    expect(fs.lstat).toHaveBeenCalledWith(`/etc/systemd/system/${unit}`);
    expect(fs.lstat).toHaveBeenCalledWith(`/run/systemd/system/${unit}`);
  });
  it("refuses filesystem uncertainty", async () => {
    vi.spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(absent()).rejects.toMatchObject({
      ownership: { status: "unverifiable", operation: "filesystem" },
    });
  });
  it.each([
    { name: "invalid object path", result: success("o", ["/unexpected"]) },
    { name: "timed out missing", result: { ...missing(), termination: "timeout" as const } },
  ])("rejects $name rather than certifying absence", async ({ result }) => {
    exec.mockImplementation(async (_command, args) =>
      args.includes("GetUnit") ? result : reply(args),
    );
    await expect(absent()).rejects.toMatchObject({ ownership: { status: "unverifiable" } });
  });
  it("rejects a replaced manager before accepting absence", async () => {
    let owners = 0;
    exec.mockImplementation(async (_command, args) =>
      args.includes("GetNameOwner") ? success("s", [++owners === 1 ? owner : ":1.9"]) : reply(args),
    );
    await expect(absent()).rejects.toMatchObject({ ownership: { status: "unverifiable" } });
  });
  it("rejects a newly loaded unit after filesystem inspection", async () => {
    let units = 0;
    exec.mockImplementation(async (_command, args) =>
      args.includes("GetUnit") && ++units > 1
        ? success("o", ["/org/freedesktop/systemd1/unit/owned"])
        : reply(args),
    );
    await expect(absent()).rejects.toMatchObject({ ownership: { status: "loaded" } });
  });
});
