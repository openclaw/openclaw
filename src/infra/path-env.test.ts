import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureClawdisCliOnPath } from "./path-env.js";

describe("ensureClawdisCliOnPath", () => {
  it("prepends the bundled Relay dir when a sibling clawdis exists", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-path-"));
    try {
      const relayDir = path.join(tmp, "Relay");
      await fs.mkdir(relayDir, { recursive: true });
      const cliPath = path.join(relayDir, "clawdis");
      await fs.writeFile(cliPath, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(cliPath, 0o755);

      const originalPath = process.env.PATH;
      const originalFlag = process.env.CLAWDIS_PATH_BOOTSTRAPPED;
      process.env.PATH = "/usr/bin";
      delete process.env.CLAWDIS_PATH_BOOTSTRAPPED;
      try {
        ensureClawdisCliOnPath({
          execPath: cliPath,
          cwd: tmp,
          homeDir: tmp,
          platform: "darwin",
        });
        const updated = process.env.PATH ?? "";
        expect(updated.split(path.delimiter)[0]).toBe(relayDir);
      } finally {
        process.env.PATH = originalPath;
        if (originalFlag === undefined)
          delete process.env.CLAWDIS_PATH_BOOTSTRAPPED;
        else process.env.CLAWDIS_PATH_BOOTSTRAPPED = originalFlag;
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent", () => {
    const originalPath = process.env.PATH;
    const originalFlag = process.env.CLAWDIS_PATH_BOOTSTRAPPED;
    process.env.PATH = "/bin";
    process.env.CLAWDIS_PATH_BOOTSTRAPPED = "1";
    try {
      ensureClawdisCliOnPath({
        execPath: "/tmp/does-not-matter",
        cwd: "/tmp",
        homeDir: "/tmp",
        platform: "darwin",
      });
      expect(process.env.PATH).toBe("/bin");
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined)
        delete process.env.CLAWDIS_PATH_BOOTSTRAPPED;
      else process.env.CLAWDIS_PATH_BOOTSTRAPPED = originalFlag;
    }
  });

  it("prepends mise shims when available", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-path-"));
    const originalPath = process.env.PATH;
    const originalFlag = process.env.CLAWDIS_PATH_BOOTSTRAPPED;
    const originalMiseDataDir = process.env.MISE_DATA_DIR;
    try {
      const relayDir = path.join(tmp, "Relay");
      await fs.mkdir(relayDir, { recursive: true });
      const relayCli = path.join(relayDir, "clawdis");
      await fs.writeFile(relayCli, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(relayCli, 0o755);

      const localBinDir = path.join(tmp, "node_modules", ".bin");
      await fs.mkdir(localBinDir, { recursive: true });
      const localCli = path.join(localBinDir, "clawdis");
      await fs.writeFile(localCli, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(localCli, 0o755);

      const miseDataDir = path.join(tmp, "mise");
      const shimsDir = path.join(miseDataDir, "shims");
      await fs.mkdir(shimsDir, { recursive: true });
      process.env.MISE_DATA_DIR = miseDataDir;
      process.env.PATH = "/usr/bin";
      delete process.env.CLAWDIS_PATH_BOOTSTRAPPED;

      ensureClawdisCliOnPath({
        execPath: relayCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
      });

      const updated = process.env.PATH ?? "";
      const parts = updated.split(path.delimiter);
      const relayIndex = parts.indexOf(relayDir);
      const localIndex = parts.indexOf(localBinDir);
      const shimsIndex = parts.indexOf(shimsDir);
      expect(relayIndex).toBeGreaterThanOrEqual(0);
      expect(localIndex).toBeGreaterThan(relayIndex);
      expect(shimsIndex).toBeGreaterThan(localIndex);
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined)
        delete process.env.CLAWDIS_PATH_BOOTSTRAPPED;
      else process.env.CLAWDIS_PATH_BOOTSTRAPPED = originalFlag;
      if (originalMiseDataDir === undefined) delete process.env.MISE_DATA_DIR;
      else process.env.MISE_DATA_DIR = originalMiseDataDir;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
