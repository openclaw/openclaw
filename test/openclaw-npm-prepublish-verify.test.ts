import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVitestNodeArgs } from "../scripts/lib/vitest-process-env.mts";
import {
  openClawNpmPrepublishVerifyUsage,
  parseOpenClawNpmPrepublishVerifyArgs,
  usesPreparedLocalDependencyInstall,
} from "../scripts/openclaw-npm-prepublish-verify.ts";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { createCommandTest } from "./helpers/command-fixture.js";

describe("prepublish CLI target admission", () => {
  const commandIt = createCommandTest();

  commandIt(
    "reads the prepublish target contract from cwd before installing",
    async ({ command }) => {
      const root = command.createTempDir("prepublish-worker-target-");
      mkdirSync(join(root, "extensions"));
      mkdirSync(join(root, "src/shared"), { recursive: true });
      mkdirSync(join(root, "src/worker"), { recursive: true });
      writeFileSync(join(root, "src/worker/worker-deploy-entry.ts"), "export {};\n");
      writeFileSync(
        join(root, "src/shared/worker-bundle-hash.ts"),
        "export const WORKER_BUNDLE_ARTIFACT_PATHS = [];\n",
      );
      const result = await command.run(
        resolveTestNodeExecPath(),
        [
          ...resolveVitestNodeArgs(),
          "--import",
          resolve("scripts/tsx.mjs"),
          resolve("scripts/openclaw-npm-prepublish-verify.ts"),
          join(root, "not-installed.tgz"),
        ],
        { cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json") } },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Target WORKER_BUNDLE_ARTIFACT_PATHS must be a non-empty array.",
      );
    },
  );
});

describe("parseOpenClawNpmPrepublishVerifyArgs", () => {
  it("supports help, optional versions, and package-manager separators", () => {
    expect(parseOpenClawNpmPrepublishVerifyArgs(["--help"])).toEqual({
      dependencyTarballPaths: [],
      help: true,
      tarballPath: "",
    });
    expect(parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz"])).toEqual({
      dependencyTarballPaths: [],
      help: false,
      tarballPath: "openclaw.tgz",
    });
    expect(parseOpenClawNpmPrepublishVerifyArgs(["--", "openclaw.tgz", "2026.3.23"])).toEqual({
      dependencyTarballPaths: [],
      expectedVersion: "2026.3.23",
      help: false,
      tarballPath: "openclaw.tgz",
    });
  });

  it("rejects missing, option-like, and extra arguments before installing", () => {
    expect(() => parseOpenClawNpmPrepublishVerifyArgs([])).toThrow(
      openClawNpmPrepublishVerifyUsage(),
    );
    expect(() => parseOpenClawNpmPrepublishVerifyArgs(["--tag"])).toThrow(
      "Unknown openclaw npm prepublish verifier option: --tag",
    );
    expect(() => parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "--tag"])).toThrow(
      "Unknown openclaw npm prepublish verifier option: --tag",
    );
    expect(
      parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "2026.3.23", "llm-core.tgz", "ai.tgz"]),
    ).toEqual({
      dependencyTarballPaths: ["llm-core.tgz", "ai.tgz"],
      expectedVersion: "2026.3.23",
      help: false,
      tarballPath: "openclaw.tgz",
    });
    expect(() =>
      parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "2026.3.23", "--bad"]),
    ).toThrow("Invalid dependency tarball path: --bad");
  });
});

describe("usesPreparedLocalDependencyInstall", () => {
  it("uses the prepared local project only for the single AI tarball release path", () => {
    expect(usesPreparedLocalDependencyInstall(0)).toBe(false);
    expect(usesPreparedLocalDependencyInstall(1)).toBe(true);
    expect(usesPreparedLocalDependencyInstall(2)).toBe(false);
  });
});
