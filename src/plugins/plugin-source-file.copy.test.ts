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

function fixture(bytes = Buffer.from("captured"), basename = "input.js") {
  const root = fs.realpathSync(dirs.make("plugin-small-copy-"));
  const source = path.join(root, basename);
  const outputRoot = path.join(root, "capture");
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(source, bytes, { mode: 0o755 });
  const target = path.join(outputRoot, basename);
  return {
    root,
    source,
    target,
    bytes,
    copy: () => copyPluginSourceFile(source, root, target, { hashCopiedContent: true }),
  };
}

it("copies small files through owned descriptors with the same bytes, identity and mode", () => {
  const subject = fixture();
  const admitted = fs.statSync(subject.source, { bigint: true });
  const clone = vi.spyOn(fsSafe, "copyRootFileSync");
  const copied = subject.copy();
  expect(clone).not.toHaveBeenCalled();
  expect(copied).toEqual({
    contentHash: createHash("sha256").update(subject.bytes).digest("hex"),
    sizeBytes: subject.bytes.length,
    sourceIdentity: pluginSourceStatIdentity(admitted),
  });
  expect(fs.readFileSync(subject.target)).toEqual(subject.bytes);
  expect(fs.statSync(subject.target).ino).not.toBe(fs.statSync(subject.source).ino);
  if (process.platform !== "win32") {
    expect(fs.statSync(subject.target).mode & 0o777).toBe(0o700);
  }
  fs.writeFileSync(subject.source, "edited");
  expect(fs.readFileSync(subject.target)).toEqual(subject.bytes);
});

it.each(["grow", "shrink", "replace", "symlink"])(
  "refuses a source that changes after descriptor admission: %s",
  (change) => {
    const subject = fixture();
    const create = fsSafe.createFileSync;
    vi.spyOn(fsSafe, "createFileSync").mockImplementation((target, options) => {
      if (target === subject.target) {
        if (change === "grow") {
          fs.appendFileSync(subject.source, "more");
        } else if (change === "shrink") {
          fs.truncateSync(subject.source, 1);
        } else {
          fs.renameSync(subject.source, `${subject.source}.original`);
          if (change === "replace") {
            fs.writeFileSync(subject.source, "replacement");
          } else {
            fs.symlinkSync(`${subject.source}.original`, subject.source);
          }
        }
      }
      return create(target, options);
    });
    expect(subject.copy).toThrow();
    expect(fs.existsSync(subject.target)).toBe(false);
  },
);

it.each(["grow", "shrink"])("refuses source %s during the bounded transfer", (change) => {
  const subject = fixture();
  const write = fs.writeSync;
  let changed = false;
  vi.spyOn(fs, "writeSync").mockImplementation((...args) => {
    if (!changed) {
      changed = true;
      if (change === "grow") {
        fs.appendFileSync(subject.source, "more");
      } else {
        fs.truncateSync(subject.source, 1);
      }
    }
    return Reflect.apply(write, fs, args);
  });
  expect(subject.copy).toThrow("Plugin source changed");
  expect(changed).toBe(true);
});

it.each(["leaf", "parent", "hardlink"])(
  "refuses substituted destination %s before transfer",
  (change) => {
    const subject = fixture();
    const transfer = fsSafe.copyFileDescriptorSync;
    vi.spyOn(fsSafe, "copyFileDescriptorSync").mockImplementation((source, target, options) => {
      if (change === "parent") {
        fs.renameSync(path.dirname(subject.target), `${path.dirname(subject.target)}.original`);
        fs.mkdirSync(path.dirname(subject.target));
        fs.writeFileSync(subject.target, "foreign");
      } else if (change === "leaf") {
        fs.renameSync(subject.target, `${subject.target}.original`);
        fs.writeFileSync(subject.target, "foreign");
      } else {
        fs.linkSync(subject.target, `${subject.target}.alias`);
      }
      return transfer(source, target, options);
    });
    expect(subject.copy).toThrow();
    if (change !== "hardlink") {
      expect(fs.readFileSync(subject.target, "utf8")).toBe("foreign");
    }
  },
);

it("preserves disk-full diagnostics and does not retry descriptor transfer", () => {
  const subject = fixture();
  const cause = Object.assign(new Error("capture filesystem is full"), { code: "ENOSPC" });
  const failure = new FsSafeError("helper-failed", "descriptor copy failed", { cause });
  const transfer = vi.spyOn(fsSafe, "copyFileDescriptorSync").mockImplementation(() => {
    throw failure;
  });
  expect(subject.copy).toThrow("capture filesystem is full");
  expect(transfer).toHaveBeenCalledOnce();
  // A failed acquisition is not retried over the partially created output.
  expect(subject.copy).toThrow(expect.objectContaining({ code: "already-exists" }));
  expect(transfer).toHaveBeenCalledOnce();
});
