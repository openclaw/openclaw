import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_ROOT, "..");
const XAI_ROOT = resolve(REPO_ROOT, "extensions/xai");
const TSC_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsc");

describe("extension package rootDir enforcement", () => {
  it("fails when an extension imports src/cli through a relative path", () => {
    const scratchDir = mkdtempSync(join(os.tmpdir(), "openclaw-extension-rootdir-"));
    const canaryPath = join(XAI_ROOT, "__rootdir_boundary_canary__.ts");
    const tsconfigPath = join(XAI_ROOT, "tsconfig.rootdir-canary.json");

    try {
      writeFileSync(
        canaryPath,
        'import * as foo from "../../src/cli/acp-cli.ts";\nvoid foo;\nexport {};\n',
        "utf8",
      );
      writeFileSync(
        tsconfigPath,
        JSON.stringify(
          {
            extends: "./tsconfig.json",
            include: ["./__rootdir_boundary_canary__.ts"],
            exclude: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });

      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("TS6059");
      expect(output).toContain("src/cli/acp-cli.ts");
    } finally {
      rmSync(canaryPath, { force: true });
      rmSync(tsconfigPath, { force: true });
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
