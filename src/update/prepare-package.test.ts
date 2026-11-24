import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePackage } from "./prepare-package.js";

describe("preparePackage", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("reports interrupted when preparePackage is cut off by spawn broker IPC disconnect", async () => {
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prepare-pkg-"));
    tempDirs.push(staging);

    const result = await preparePackage({
      spec: "openclaw@latest",
      staging,
      npm: [
        process.execPath,
        "-e",
        "process.stderr.write('Spawn broker exited; command outcome is unavailable | IPC channel disconnected'); process.exit(1);",
      ],
      node: process.execPath,
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "interrupted",
    });
  });

  it("reports package-install-failed for ordinary npm failures", async () => {
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prepare-pkg-"));
    tempDirs.push(staging);

    const result = await preparePackage({
      spec: "openclaw@latest",
      staging,
      npm: [process.execPath, "-e", "process.stderr.write('E404 not found'); process.exit(1);"],
      node: process.execPath,
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "package-install-failed",
    });
  });
});
