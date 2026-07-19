import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatUpdateSwapCoverageWarning,
  resolveUpdateSwapCoverage,
} from "./update-swap-coverage.js";

describe("update swap coverage", () => {
  it.runIf(process.platform !== "win32")(
    "enables retention only for a verified install-cli managed npm prefix",
    async () => {
      const temporaryPrefix = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-prefix-"));
      const prefix = await fs.realpath(temporaryPrefix);
      const nodeVersionRoot = path.join(prefix, "tools", "node-v24");
      const packageRoot = path.join(nodeVersionRoot, "lib", "node_modules", "openclaw");
      const nodePath = path.join(nodeVersionRoot, "bin", "node");
      await fs.mkdir(path.dirname(nodePath), { recursive: true });
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
      await fs.writeFile(nodePath, "#!/bin/sh\n", { mode: 0o700 });
      await fs.symlink(nodeVersionRoot, path.join(prefix, "tools", "node"));
      await fs.writeFile(
        path.join(prefix, "bin", "openclaw"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `exec "${prefix}/tools/node/bin/node" "${packageRoot}/dist/entry.js" "$@"`,
          "",
        ].join("\n"),
        { mode: 0o700 },
      );

      for (const candidateRoot of [
        packageRoot,
        path.join(prefix, "tools", "node", "lib", "node_modules", "openclaw"),
      ]) {
        expect(
          await resolveUpdateSwapCoverage({
            packageRoot: candidateRoot,
            manager: "npm",
            platform: "linux",
          }),
        ).toMatchObject({
          kind: "managed-prefix",
          protection: "transactional-rollback",
          prefix,
        });
      }
      await fs.rm(temporaryPrefix, { recursive: true });
    },
  );

  it("warns for a lookalike prefix without installer provenance", async () => {
    const coverage = await resolveUpdateSwapCoverage({
      packageRoot: "/home/molly/.openclaw/tools/node-v24/lib/node_modules/openclaw",
      manager: "npm",
      platform: "linux",
    });
    expect(coverage.protection).toBe("detect-warn");
  });

  it("warns for ordinary npm globals", async () => {
    const coverage = await resolveUpdateSwapCoverage({
      packageRoot: "/usr/local/lib/node_modules/openclaw",
      manager: "npm",
      platform: "darwin",
    });
    expect(coverage.protection).toBe("detect-warn");
    expect(formatUpdateSwapCoverageWarning(coverage)).toContain("https://openclaw.ai/install.sh");
  });
});
