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
});
