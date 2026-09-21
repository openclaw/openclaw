import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExec } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { reconcileWindowsGitLauncher } from "./windows-git-launcher.js";

vi.mock("../process/exec.js", () => ({ runExec: vi.fn() }));
vi.mock("./directory-durability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./directory-durability.js")>();
  return { ...actual, syncDirectoryBestEffort: vi.fn(actual.syncDirectoryBestEffort) };
});
const probe = vi.mocked(runExec);
const supported = {
  stdout: JSON.stringify({
    nodeVersion: "24.16.0",
    sqliteVersion: "3.51.3",
    sqliteSelectionError: null,
    nodeSharedSqlite: false,
    sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
  }),
  stderr: "",
};
const foreign = "@echo off\r\necho concurrent npm or custom owner\r\n";
async function fixture(root: string, missing = false) {
  const nodePath = path.join(root, "node.exe");
  const entryPath = path.join(root, "entry.js");
  const launcherPath = path.join(root, "bin", "openclaw.cmd");
  await fs.mkdir(path.dirname(launcherPath));
  await fs.writeFile(nodePath, "node");
  await fs.writeFile(entryPath, "entry");
  const original = `@echo off\r\nnode "${entryPath}" %*\r\n`;
  if (!missing) {
    await fs.writeFile(launcherPath, original);
  }
  return {
    original,
    params: {
      root,
      repair: true,
      create: true,
      platform: "win32" as const,
      nodePath,
      entryPath,
      launcherPath,
    },
  };
}

describe("Windows launcher concurrent publication", () => {
  beforeEach(() => {
    probe.mockReset();
    vi.mocked(syncDirectoryBestEffort).mockReset();
    probe.mockResolvedValue(supported);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "preserves a launcher replaced during validation (initially missing=%s)",
    async (missing) => {
      await withTestDir({ prefix: "openclaw-launcher-concurrent-" }, async (root) => {
        const { params } = await fixture(root, missing);
        probe.mockImplementationOnce(async () => {
          await fs.writeFile(params.launcherPath, foreign);
          return supported;
        });
        await expect(reconcileWindowsGitLauncher(params)).resolves.toEqual({
          status: "skipped",
          reason: "foreign",
        });
        expect(await fs.readFile(params.launcherPath, "utf8")).toBe(foreign);
        expect(await fs.readdir(path.dirname(params.launcherPath))).toEqual(["openclaw.cmd"]);
      });
    },
  );

  it("retains recovery bytes when another publisher wins after the owner claim", async () => {
    await withTestDir({ prefix: "openclaw-launcher-concurrent-" }, async (root) => {
      const { params, original } = await fixture(root);
      const link = fs.link.bind(fs);
      vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
        if (String(source).endsWith("next.cmd") && destination === params.launcherPath) {
          await fs.writeFile(params.launcherPath, foreign, { flag: "wx" });
        }
        return link(source, destination);
      });
      await expect(reconcileWindowsGitLauncher(params)).rejects.toThrow(/recovery.*original.cmd/);
      expect(await fs.readFile(params.launcherPath, "utf8")).toBe(foreign);
      const recovery = (await fs.readdir(path.dirname(params.launcherPath))).find((name) =>
        name.startsWith(".openclaw-launcher-"),
      );
      expect(recovery).toBeDefined();
      expect(
        await fs.readFile(
          path.join(path.dirname(params.launcherPath), recovery!, "original.cmd"),
          "utf8",
        ),
      ).toBe(original);
    });
  });

  it("leaves an existing launcher in place when hard links are unsupported", async () => {
    await withTestDir({ prefix: "openclaw-launcher-concurrent-" }, async (root) => {
      const { params, original } = await fixture(root);
      const rename = vi.spyOn(fs, "rename");
      vi.spyOn(fs, "link").mockRejectedValue(
        Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" }),
      );
      await expect(reconcileWindowsGitLauncher(params)).rejects.toThrow("hard links unavailable");
      expect(rename).not.toHaveBeenCalled();
      expect(await fs.readFile(params.launcherPath, "utf8")).toBe(original);
      expect(await fs.readdir(path.dirname(params.launcherPath))).toEqual(["openclaw.cmd"]);
    });
  });

  it("flushes the published directory before removing the previous launcher recovery", async () => {
    await withTestDir({ prefix: "openclaw-launcher-concurrent-" }, async (root) => {
      const { params, original } = await fixture(root);
      let publicationFlushObserved = false;
      vi.mocked(syncDirectoryBestEffort).mockImplementation(async (directory) => {
        if (directory !== path.dirname(params.launcherPath) || publicationFlushObserved) {
          return;
        }
        const current = await fs.readFile(params.launcherPath, "utf8").catch(() => "");
        if (!current.includes("rem OpenClaw Git launcher")) {
          return;
        }
        const recovery = (await fs.readdir(directory)).find((name) =>
          name.startsWith(".openclaw-launcher-"),
        );
        expect(recovery).toBeDefined();
        expect(await fs.readFile(path.join(directory, recovery!, "original.cmd"), "utf8")).toBe(
          original,
        );
        publicationFlushObserved = true;
      });
      await expect(reconcileWindowsGitLauncher(params)).resolves.toEqual({
        status: "updated",
        launcherPath: params.launcherPath,
      });
      expect(publicationFlushObserved).toBe(true);
      expect(await fs.readdir(path.dirname(params.launcherPath))).toEqual(["openclaw.cmd"]);
    });
  });

  it("restores the claimed launcher when publication fails", async () => {
    await withTestDir({ prefix: "openclaw-launcher-concurrent-" }, async (root) => {
      const { params, original } = await fixture(root);
      const link = fs.link.bind(fs);
      vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
        if (String(source).endsWith("next.cmd") && destination === params.launcherPath) {
          throw Object.assign(new Error("injected publication failure"), { code: "EIO" });
        }
        return link(source, destination);
      });
      await expect(reconcileWindowsGitLauncher(params)).rejects.toThrow(
        "injected publication failure",
      );
      expect(await fs.readFile(params.launcherPath, "utf8")).toBe(original);
      expect(await fs.readdir(path.dirname(params.launcherPath))).toEqual(["openclaw.cmd"]);
    });
  });
});
