import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as fsSafe from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copyPluginSourceFile, pluginSourceStatIdentity } from "./plugin-source-file.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture(bytes = Buffer.from("captured")) {
  const root = fs.realpathSync(dirs.make("plugin-small-copy-"));
  const source = path.join(root, "input.js");
  fs.mkdirSync(path.join(root, "capture"));
  fs.writeFileSync(source, bytes, { mode: 0o755 });
  const target = path.join(root, "capture", "input.js");
  const copy = () => copyPluginSourceFile(source, root, target, { hashCopiedContent: true });
  return { root, source, target, bytes, copy };
}

it("copies small files through owned descriptors with the same bytes, identity and mode", () => {
  const { source, target, bytes, copy } = fixture();
  const admitted = fs.statSync(source, { bigint: true });
  const copied = copy();
  expect(copied).toEqual({
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    sourceIdentity: pluginSourceStatIdentity(admitted),
  });
  expect(fs.statSync(target).ino).not.toBe(fs.statSync(source).ino);
  if (process.platform !== "win32") {
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  }
  fs.writeFileSync(source, "edited");
  expect(fs.readFileSync(target)).toEqual(bytes);
});

it("refuses source growth during the bounded transfer", () => {
  const { source, copy } = fixture();
  const write = fs.writeSync;
  let changed = false;
  vi.spyOn(fs, "writeSync").mockImplementation((...args) => {
    if (!changed) {
      changed = true;
      fs.appendFileSync(source, "more");
    }
    return Reflect.apply(write, fs, args);
  });
  expect(copy).toThrow("Plugin source changed");
});

it.each(["leaf", "parent", "hardlink"])("refuses substituted destination %s", (change) => {
  const { target: destination, copy } = fixture();
  const transfer = fsSafe.copyFileDescriptorSync;
  vi.spyOn(fsSafe, "copyFileDescriptorSync").mockImplementation((source, target, options) => {
    if (change === "hardlink") {
      fs.linkSync(destination, `${destination}.alias`);
    } else {
      const replaced = change === "parent" ? path.dirname(destination) : destination;
      fs.renameSync(replaced, `${replaced}.original`);
      if (change === "parent") {
        fs.mkdirSync(replaced);
      }
      fs.writeFileSync(destination, "foreign");
    }
    return transfer(source, target, options);
  });
  expect(copy).toThrow();
  if (change !== "hardlink") {
    expect(fs.readFileSync(destination, "utf8")).toBe("foreign");
  }
});

it("preserves disk-full diagnostics and does not retry descriptor transfer", () => {
  const { copy } = fixture();
  const cause = Object.assign(new Error("capture filesystem is full"), { code: "ENOSPC" });
  const failure = new FsSafeError("helper-failed", "descriptor copy failed", { cause });
  const transfer = vi.spyOn(fsSafe, "copyFileDescriptorSync").mockImplementation(() => {
    throw failure;
  });
  expect(copy).toThrow("capture filesystem is full");
  expect(transfer).toHaveBeenCalledOnce();
  expect(copy).toThrow(expect.objectContaining({ code: "already-exists" }));
  expect(transfer).toHaveBeenCalledOnce();
});

it("admits Windows copies through the native spelling of an aliased root", () => {
  const { root, source, target } = fixture(Buffer.alloc(128 * 1024, 1));
  // A symlink stands in for an 8.3 alias: its native realpath differs from its spelling.
  const alias = `${root}-alias`;
  fs.symlinkSync(root, alias, "dir");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const copyFile = vi.fn<typeof fsSafe.copyRootFileSync>(() => {
    throw new FsSafeError("path-mismatch", "fixture stop");
  });

  expect(() =>
    copyPluginSourceFile(path.join(alias, "input.js"), alias, target, { copyFile }),
  ).toThrow("fixture stop");
  expect(copyFile.mock.calls[0]?.[0].source).toEqual({
    rootPath: root,
    absolutePath: source,
  });
  fs.unlinkSync(alias);
});
