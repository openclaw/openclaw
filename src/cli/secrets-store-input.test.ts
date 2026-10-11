import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { readSecretStoreImport, readSecretStoreInput } from "./secrets-store-input.js";

const execFileAsync = promisify(execFile);

describe("secret store file input", () => {
  it.skipIf(process.platform === "win32").each([
    { name: "value-file", read: readSecretStoreInput },
    { name: "dotenv import", read: readSecretStoreImport },
  ])("rejects a FIFO for $name without waiting for a writer", async ({ read }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "secret-store-input-fifo-"));
    const fifo = path.join(directory, "input");
    const setup = execFileAsync("mkfifo", [fifo]);
    const reading = setup.then<Awaited<ReturnType<typeof read>>>(() => read(fifo));
    onTestFinished(async () => {
      try {
        if (
          await setup.then(
            () => true,
            () => false,
          )
        ) {
          // Release a regressed blocking open after the test's own deadline, without a writer race.
          const release = await fs.open(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
          try {
            await reading.catch(() => undefined);
          } finally {
            await release.close();
          }
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
    await expect(reading).rejects.toThrow(`Input path is not a regular file: ${fifo}`);
  });
});
