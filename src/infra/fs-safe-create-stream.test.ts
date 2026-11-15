import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { root } from "./fs-safe.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("publishes complete streamed contents exclusively through the root facade", async () => {
  const dir = tempDirs.make("openclaw-fs-safe-stream-");
  const scoped = await root(dir);
  const target = path.join(dir, "payload.txt");
  async function* input() {
    yield Buffer.from("hello ");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    yield new TextEncoder().encode("world");
  }

  await scoped.create("payload.txt", input(), { maxBytes: 11 });
  await expect(fs.readFile(target, "utf8")).resolves.toBe("hello world");
  await expect(
    scoped.create(
      "payload.txt",
      (async function* () {
        yield Buffer.from("replacement");
      })(),
    ),
  ).rejects.toMatchObject({ code: "already-exists" });
  await expect(fs.readFile(target, "utf8")).resolves.toBe("hello world");
});

it("does not publish a stream that exceeds the byte budget", async () => {
  const dir = tempDirs.make("openclaw-fs-safe-stream-limit-");
  const scoped = await root(dir);
  async function* input() {
    yield Buffer.from("oversized");
  }

  await expect(scoped.create("payload.txt", input(), { maxBytes: 4 })).rejects.toMatchObject({
    code: "too-large",
  });
  await expect(fs.readdir(dir)).resolves.toEqual([]);
});
