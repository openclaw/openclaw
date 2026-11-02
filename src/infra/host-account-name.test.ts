import fs from "node:fs/promises";
import os from "node:os";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runExecMock = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", () => ({ runExec: runExecMock }));

let resolveHostAccountName: typeof import("./host-account-name.js").resolveHostAccountName;
let freshModuleId = 0;
const platform = (value: NodeJS.Platform) =>
  vi.spyOn(process, "platform", "get").mockReturnValue(value);
const stdout = (value: string) => runExecMock.mockResolvedValue({ stdout: value, stderr: "" });

beforeEach(async () => {
  ({ resolveHostAccountName } = await importFreshModule<typeof import("./host-account-name.js")>(
    import.meta.url,
    `./host-account-name.js?test=${freshModuleId++}`,
  ));
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "ada",
    uid: 1000,
    gid: 1000,
    homedir: "/home/ada",
    shell: "/bin/sh",
  });
});

afterEach(() => {
  runExecMock.mockReset();
  vi.restoreAllMocks();
});

describe("resolveHostAccountName", () => {
  it("trims the macOS full name and shares one lookup across concurrent callers", async () => {
    platform("darwin");
    stdout("  Ada Lovelace \n");
    expect(await Promise.all([resolveHostAccountName(), resolveHostAccountName()])).toEqual([
      "Ada Lovelace",
      "Ada Lovelace",
    ]);
    await expect(resolveHostAccountName()).resolves.toBe("Ada Lovelace");
    expect(runExecMock).toHaveBeenCalledOnce();
  });

  it.each(["RealName: Ada Lovelace\n", "RealName:\n Ada Lovelace\n"])(
    "reads a macOS directory full name after id fails: %s",
    async (directoryOutput) => {
      platform("darwin");
      runExecMock
        .mockRejectedValueOnce(new Error("id failed"))
        .mockResolvedValueOnce({ stdout: directoryOutput, stderr: "" });

      await expect(resolveHostAccountName()).resolves.toBe("Ada Lovelace");
    },
  );

  it.each([
    { gecos: " Ada Lovelace ,Room 42,555-0100", expected: "Ada Lovelace" },
    { gecos: ",Room 42", expected: null },
    { gecos: "ada", expected: null },
    { gecos: `${"A".repeat(255)}🤖`, expected: "A".repeat(255) },
  ])("uses only a bounded human name from Linux GECOS: $gecos", async ({ gecos, expected }) => {
    platform("linux");
    stdout(`ada:x:1000:1000:${gecos}:/home/ada:/bin/sh\n`);
    await expect(resolveHostAccountName()).resolves.toBe(expected);
  });

  it("selects the host account from passwd when getent is unavailable", async () => {
    platform("linux");
    runExecMock.mockRejectedValue(new Error("getent unavailable"));
    vi.spyOn(fs, "readFile").mockResolvedValue(
      "root:x:0:0:root:/root:/bin/sh\nada:x:1000:1000:Ada Lovelace,Room 42:/home/ada:/bin/sh\n",
    );
    await expect(resolveHostAccountName()).resolves.toBe("Ada Lovelace");
  });

  it("bounds subprocess timeouts and caches lookup failure without throwing", async () => {
    platform("darwin");
    runExecMock.mockRejectedValue(Object.assign(new Error("timed out"), { timedOut: true }));
    await expect(resolveHostAccountName()).resolves.toBeNull();
    await expect(resolveHostAccountName()).resolves.toBeNull();
    expect(runExecMock).toHaveBeenCalledTimes(2);
    for (const call of runExecMock.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: 1000, logOutput: false });
    }
  });

  it("does not replace a missing full name with the macOS login", async () => {
    platform("darwin");
    runExecMock
      .mockResolvedValueOnce({ stdout: "ada\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "RealName:\n", stderr: "" });

    await expect(resolveHostAccountName()).resolves.toBeNull();
  });

  it("ignores unavailable OS account metadata and unreadable passwd files", async () => {
    platform("linux");
    runExecMock.mockRejectedValue(new Error("getent unavailable"));
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("permission denied"));
    await expect(resolveHostAccountName()).resolves.toBeNull();
  });

  it("returns no name on unsupported platforms", async () => {
    platform("win32");

    await expect(resolveHostAccountName()).resolves.toBeNull();
    expect(runExecMock).not.toHaveBeenCalled();
    expect(os.userInfo).not.toHaveBeenCalled();
  });
});
