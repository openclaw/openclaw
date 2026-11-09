import { once } from "node:events";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import { Server } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { startBrokerExeca } from "./execa-worker.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function observeSocketDirectories() {
  const observed: Array<{ directory: string; mode: number }> = [];
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the intercepted Server receiver.
  const listen = Server.prototype.listen;
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (
    this: Server,
    ...args: Parameters<Server["listen"]>
  ) {
    if (typeof args[0] === "string") {
      const directory = path.dirname(args[0]);
      observed.push({ directory, mode: statSync(directory).mode & 0o777 });
    }
    return Reflect.apply(listen, this, args);
  });
  return observed;
}

async function bufferedCommand(marker: string, assertCurrent = () => {}) {
  const run = await startBrokerExeca(
    [
      process.execPath,
      "-e",
      'require("node:fs").writeFileSync(process.argv[1], "launched"); process.stdout.write("out"); process.stderr.write("err");',
      marker,
    ],
    { stdin: "ignore", encoding: "utf8", reject: false },
    assertCurrent,
  );
  const closed = once(run.child, "close");
  try {
    return await run.result;
  } finally {
    // Small buffered results are already owned by Execa; acknowledge their unused transfer pipes.
    run.outputDrained(1);
    run.outputDrained(2);
    await closed;
  }
}

async function expectRemoved(observed: Array<{ directory: string; mode: number }>) {
  expect(observed.length).toBeGreaterThan(0);
  for (const entry of observed) {
    expect(entry.mode).toBe(0o700);
    await expect(fs.lstat(entry.directory)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

describe.skipIf(!supportsSpawnBrokerCommandTransport())("buffered broker temp paths", () => {
  it("preserves output with absolute long and UTF-8-byte-overlong temp roots", async () => {
    // Explicit short root isolates the UTF-8 byte limit from a long CI checkout pathname.
    const root = directories.make("oc-bp-", "/tmp");
    const observed = observeSocketDirectories();
    for (const segment of ["native-repository-inheritance-".repeat(4), "é".repeat(40)]) {
      const temporary = path.join(root, segment);
      await fs.mkdir(temporary, { mode: 0o700 });
      expect(path.isAbsolute(temporary)).toBe(true);
      expect(Buffer.byteLength(temporary)).toBeGreaterThan(83);
      if (segment.startsWith("é")) {
        expect(temporary.length).toBeLessThan(83);
      }
      vi.stubEnv("TMPDIR", temporary);
      const marker = path.join(root, "effect");
      await expect(bufferedCommand(marker)).resolves.toMatchObject({
        exitCode: 0,
        stdout: "out",
        stderr: "err",
      });
      expect(await fs.readFile(marker, "utf8")).toBe("launched");
      await expect(fs.readdir(temporary)).resolves.toEqual([]);
    }
    await expectRemoved(observed);
  });

  it("retains short roots, launch refusal and invalid/unwritable temp-root failures", async () => {
    const root = directories.make("oc-bp-", "/tmp");
    const observed = observeSocketDirectories();
    const marker = path.join(root, "effect");
    vi.stubEnv("TMPDIR", root);
    await expect(bufferedCommand(marker)).resolves.toMatchObject({ exitCode: 0 });
    expect(observed.every(({ directory }) => path.dirname(directory) === root)).toBe(true);
    await fs.rm(marker);

    const long = path.join(root, "long-private-temporary-directory-".repeat(4));
    await fs.mkdir(long, { mode: 0o700 });
    vi.stubEnv("TMPDIR", long);
    const refusal = new Error("launch authority revoked");
    await expect(
      bufferedCommand(marker, () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(long)).resolves.toEqual([]);
    await expectRemoved(observed);

    vi.stubEnv("TMPDIR", path.join(root, "missing"));
    await expect(bufferedCommand(marker)).rejects.toMatchObject({ code: "ENOENT" });
    if (process.getuid?.() !== 0) {
      const unwritable = path.join(root, "unwritable");
      await fs.mkdir(unwritable, { mode: 0o500 });
      vi.stubEnv("TMPDIR", unwritable);
      await expect(bufferedCommand(marker)).rejects.toMatchObject({ code: "EACCES" });
    }
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
