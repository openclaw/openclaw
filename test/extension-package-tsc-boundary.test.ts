import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const XAI_ROOT = resolve(REPO_ROOT, "extensions/xai");
const TSC_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsc");
const PLUGIN_SDK_DTS_TSCONFIG = resolve(REPO_ROOT, "tsconfig.plugin-sdk.dts.json");

describe("xai package TypeScript boundary", () => {
  it("typechecks cleanly through @openclaw/plugin-sdk", () => {
    const prepareResult = spawnSync(TSC_BIN, ["-p", PLUGIN_SDK_DTS_TSCONFIG], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(prepareResult.status, `${prepareResult.stdout}\n${prepareResult.stderr}`).toBe(0);

    const result = spawnSync(TSC_BIN, ["-p", resolve(XAI_ROOT, "tsconfig.json"), "--noEmit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("fails when xai imports src/cli through a relative path", () => {
    const canaryPath = resolve(XAI_ROOT, "__rootdir_boundary_canary__.ts");
    const tsconfigPath = resolve(XAI_ROOT, "tsconfig.rootdir-canary.json");

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
    }
  });
});
