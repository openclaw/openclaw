import type * as NodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { forwardToReleaseLauncher } from "../../release-launcher-forward.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const metadata = vi.hoisted(() => ({ unsafePath: "", foreignOwner: false, writable: false }));
// Fixed external ownership facts let unprivileged CI exercise root's loader policy.
vi.mock("node:fs", async (original) => {
  const native = await original<typeof NodeFs>();
  return {
    ...native,
    lstatSync: (entry: NodeFs.PathLike) => {
      const stat = native.lstatSync(entry);
      stat.uid = metadata.foreignOwner && entry === metadata.unsafePath ? 2001 : 0;
      stat.mode &= ~0o022;
      if (metadata.writable && entry === metadata.unsafePath) {
        stat.mode |= 0o022;
      }
      return stat;
    },
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.skipIf(process.platform === "win32").each([
  { unsafe: "launcher", foreignOwner: true, writable: false, forwards: false },
  { unsafe: "parent", foreignOwner: true, writable: false, forwards: false },
  { unsafe: "parent", foreignOwner: false, writable: true, forwards: false },
  { unsafe: "none", foreignOwner: false, writable: false, forwards: true },
])("root forwards only a root-controlled launcher tree: $unsafe", async (scenario) => {
  const root = dirs.make("root-launcher-authority-");
  const packageRoot = path.join(root, "package");
  const launcher = path.join(root, "launcher.mjs");
  const witness = path.join(root, "executed");
  await fs.mkdir(packageRoot);
  await fs.writeFile(
    launcher,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(witness)}, "executed");`,
  );
  await fs.writeFile(path.join(packageRoot, ".openclaw-launcher"), `${launcher}\n`);
  metadata.unsafePath = scenario.unsafe === "launcher" ? launcher : root;
  metadata.foreignOwner = scenario.foreignOwner;
  metadata.writable = scenario.writable;
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.stubEnv("OPENCLAW_RELEASE_LAUNCHER_FORWARDED", undefined);
  const warning = vi.spyOn(console, "error").mockImplementation(() => {});
  const argv = [...process.argv];
  try {
    expect(await forwardToReleaseLauncher(pathToFileURL(packageRoot + path.sep))).toBe(
      scenario.forwards,
    );
    if (scenario.forwards) {
      expect(await fs.readFile(witness, "utf8")).toBe("executed");
      expect(warning).not.toHaveBeenCalled();
    } else {
      await expect(fs.stat(witness)).rejects.toMatchObject({ code: "ENOENT" });
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`Not forwarding to release launcher ${launcher}`),
      );
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Continuing with this installed package"),
      );
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("Run as the service account"));
    }
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
  }
});
