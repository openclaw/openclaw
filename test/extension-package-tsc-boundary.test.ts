import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectOptInExtensionPackageBoundaries } from "../scripts/lib/extension-package-boundary.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const TSC_BIN = require.resolve("typescript/bin/tsc");
const PLUGIN_SDK_DTS_TSCONFIG = resolve(REPO_ROOT, "tsconfig.plugin-sdk.dts.json");
const OPT_IN_EXTENSION_IDS = collectOptInExtensionPackageBoundaries(REPO_ROOT);

function runTsc(args: string[]) {
  return spawnSync(process.execPath, [TSC_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

describe("opt-in extension package TypeScript boundaries", () => {
  it("typechecks each opt-in extension cleanly through @openclaw/plugin-sdk", () => {
    const prepareResult = runTsc(["-p", PLUGIN_SDK_DTS_TSCONFIG]);
    expect(prepareResult.status, `${prepareResult.stdout}\n${prepareResult.stderr}`).toBe(0);

    for (const extensionId of OPT_IN_EXTENSION_IDS) {
      const result = runTsc([
        "-p",
        resolve(REPO_ROOT, "extensions", extensionId, "tsconfig.json"),
        "--noEmit",
      ]);
      expect(result.status, `${extensionId}\n${result.stdout}\n${result.stderr}`).toBe(0);
    }
  });

  it.each(OPT_IN_EXTENSION_IDS)(
    "fails when %s imports src/cli through a relative path",
    (extensionId) => {
      const extensionRoot = resolve(REPO_ROOT, "extensions", extensionId);
      const canaryPath = resolve(extensionRoot, "__rootdir_boundary_canary__.ts");
      const tsconfigPath = resolve(extensionRoot, "tsconfig.rootdir-canary.json");

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

        const result = runTsc(["-p", tsconfigPath, "--noEmit"]);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(output).toContain("TS6059");
        expect(output).toContain("src/cli/acp-cli.ts");
      } finally {
        rmSync(canaryPath, { force: true });
        rmSync(tsconfigPath, { force: true });
      }
    },
  );
});
