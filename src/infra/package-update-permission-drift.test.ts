import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPackagePublicationTreeMatcher } from "./package-update-publication-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

// Frozen pre-fix retained-tree encoding: full modes, post-order, no ctime/nlink.
function originalReceipt(root: string) {
  const digest = createHash("sha256");
  const visit = (relative: string) => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file, { bigint: true });
    const retained = [stat.dev + ":" + stat.ino, stat.mode, stat.uid, stat.gid].map(String);
    if (!stat.isDirectory()) {
      retained.push(String(stat.size), String(stat.mtimeNs));
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file).toSorted()) {
        visit(relative ? `${relative}/${child}` : child);
      }
    } else if (stat.isSymbolicLink()) {
      retained.push("symlink", fs.readlinkSync(file));
    } else {
      retained.push("file", createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    }
    digest.update(JSON.stringify([relative, retained]));
  };
  visit("");
  const stat = fs.statSync(root, { bigint: true });
  return { digest: digest.digest("hex"), identity: `${stat.dev}:${stat.ino}`, version: "1.0.0" };
}

function fixture(publicModes = false) {
  const root = dirs.make("publication-permission-drift-");
  const directory = path.join(root, "dist");
  const manifest = path.join(root, "package.json");
  const payload = path.join(directory, "index.js");
  fs.mkdirSync(directory);
  fs.writeFileSync(manifest, '{"name":"openclaw","version":"1.0.0"}\n');
  fs.writeFileSync(payload, "export {};\n");
  for (const file of [root, directory, manifest, payload]) {
    fs.chmodSync(
      file,
      fs.statSync(file).isDirectory() ? (publicModes ? 0o755 : 0o700) : publicModes ? 0o644 : 0o600,
    );
  }
  fs.symlinkSync("dist/index.js", path.join(root, "entry"));
  const previous = originalReceipt(root);
  const warning = vi.fn();
  const matcher = () =>
    createPackagePublicationTreeMatcher(
      { previous, candidate: { ...previous }, helperDigest: "0".repeat(64) },
      warning,
    );
  return { root, directory, manifest, payload, previous, warning, matcher };
}

it.skipIf(process.platform === "win32")(
  "repairs widened permissions against a pre-fix receipt",
  async () => {
    const f = fixture();
    for (const file of [f.root, f.directory, f.manifest, f.payload]) {
      fs.chmodSync(file, fs.statSync(file).mode | 0o050);
    }
    await expect(f.matcher().matches(f.root, f.previous, f.root)).resolves.toBe(true);
    expect(
      [f.root, f.directory, f.manifest, f.payload].map((file) => fs.statSync(file).mode & 0o777),
    ).toEqual([0o700, 0o700, 0o600, 0o600]);
    expect(f.warning).toHaveBeenCalledTimes(1);
    expect(f.warning.mock.calls[0]?.[0]).toMatch(/4.*ACL/);
    // Recovery in a new process must still accept the original serialized receipt.
    await expect(f.matcher().matches(f.root, { ...f.previous }, f.root)).resolves.toBe(true);
    expect(f.warning).toHaveBeenCalledTimes(1);
  },
);

it.skipIf(process.platform === "win32").each(["bytes", "owner-mode", "inode", "target"])(
  "does not repair a tree with changed %s",
  async (changed) => {
    const f = fixture();
    fs.chmodSync(f.manifest, 0o650);
    if (changed === "bytes") {
      fs.writeFileSync(f.payload, "export {x};\n");
    }
    if (changed === "owner-mode") {
      fs.chmodSync(f.payload, 0o400);
    }
    if (changed === "inode") {
      fs.renameSync(f.payload, path.join(dirs.make("original-inode-"), "index.js"));
      fs.writeFileSync(f.payload, "export {};\n", { mode: 0o600 });
    }
    if (changed === "target") {
      fs.unlinkSync(path.join(f.root, "entry"));
      fs.symlinkSync("package.json", path.join(f.root, "entry"));
    }
    await expect(f.matcher().matches(f.root, f.previous, f.root)).rejects.toThrow(
      "Package publication object changed",
    );
    expect(fs.statSync(f.manifest).mode & 0o777).toBe(0o650);
    expect(f.warning).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === "win32")(
  "keeps old public-mode receipts valid across recovery attempts",
  async () => {
    const f = fixture(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.matcher().matches(f.root, { ...f.previous }, f.root)).resolves.toBe(true);
    }
    expect(fs.statSync(f.payload).mode & 0o777).toBe(0o644);
  },
);

it.skipIf(process.platform !== "linux")("repairs a recursive named-user POSIX ACL", async () => {
  const f = fixture();
  execFileSync("setfacl", ["-R", "-m", "u:65534:rX", f.root]);
  expect(fs.statSync(f.payload).mode & 0o077).not.toBe(0);
  await expect(f.matcher().matches(f.root, f.previous, f.root)).resolves.toBe(true);
  for (const file of [f.root, f.directory, f.manifest, f.payload]) {
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(execFileSync("getfacl", ["-cp", file], { encoding: "utf8" })).toContain("mask::---");
  }
  expect(f.warning).toHaveBeenCalledTimes(1);
});

it.skipIf(process.platform === "win32")(
  "warns and continues when verified permissions cannot be tightened",
  async () => {
    const f = fixture();
    fs.chmodSync(f.manifest, 0o640);
    vi.spyOn(fs, "fchmodSync").mockImplementation(() => {
      throw Object.assign(new Error("read-only filesystem"), { code: "EROFS" });
    });
    await expect(f.matcher().matches(f.root, f.previous, f.root)).resolves.toBe(true);
    expect(f.warning).toHaveBeenCalledTimes(1);
    expect(f.warning.mock.calls[0]?.[0]).toContain("Could not tighten 1 objects");
  },
);
