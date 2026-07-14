import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  createPackageRuntimeEnv,
  resolvePackageRuntimeNpmCommand,
  resolvePackageRuntimeNpmInvocation,
} from "./package-runtime-env.js";

describe("createPackageRuntimeEnv", () => {
  it("prepends the selected Node directory without mutating the caller env", () => {
    const env = { Path: "/usr/bin" };

    const result = createPackageRuntimeEnv(env, "/service/bin/node");

    expect(result?.Path?.split(path.delimiter)[0]).toBe("/service/bin");
    expect(result).not.toHaveProperty("PATH");
    expect(env).toEqual({ Path: "/usr/bin" });
  });

  it("leaves PATH unchanged for a non-absolute runtime command", () => {
    const env = { PATH: "/usr/bin" };

    expect(createPackageRuntimeEnv(env, "node")).toBe(env);
  });

  it("recognizes forward-slash Windows Node paths", () => {
    const result = createPackageRuntimeEnv(
      { Path: "C:\\Windows\\System32" },
      "C:/Program Files/nodejs/node.exe",
    );

    expect(result?.Path?.startsWith(`C:/Program Files/nodejs${path.delimiter}`)).toBe(true);
    expect(resolvePackageRuntimeNpmCommand("C:/Program Files/nodejs/node.exe")).toBe(
      "C:\\Program Files\\nodejs\\npm.cmd",
    );
  });

  it("runs a resolved fallback npm CLI under the selected Node", async () => {
    await withTempDir({ prefix: "openclaw-package-runtime-npm-" }, async (base) => {
      const nodePath = path.join(
        base,
        "service",
        process.platform === "win32" ? "node.exe" : "node",
      );
      const npmCommand = path.join(
        base,
        "prefix",
        "bin",
        process.platform === "win32" ? "npm.cmd" : "npm",
      );
      const npmCli = path.join(base, "prefix", "lib", "node_modules", "npm", "bin", "npm-cli.js");
      await fs.mkdir(path.dirname(npmCommand), { recursive: true });
      await fs.mkdir(path.dirname(npmCli), { recursive: true });
      await fs.writeFile(npmCommand, "#!/bin/sh\n", "utf8");
      await fs.chmod(npmCommand, 0o755);
      await fs.writeFile(npmCli, "", "utf8");

      await expect(
        resolvePackageRuntimeNpmInvocation({
          nodePath,
          fallbackCommand: npmCommand,
        }),
      ).resolves.toEqual([nodePath, npmCli]);
    });
  });

  it("fails closed when a fallback npm shim has no resolvable CLI", async () => {
    await withTempDir({ prefix: "openclaw-package-runtime-npm-missing-" }, async (base) => {
      const nodePath = path.join(
        base,
        "service",
        process.platform === "win32" ? "node.exe" : "node",
      );
      const npmCommand = path.join(
        base,
        "prefix",
        "bin",
        process.platform === "win32" ? "npm.cmd" : "npm",
      );
      await fs.mkdir(path.dirname(npmCommand), { recursive: true });
      await fs.writeFile(npmCommand, "#!/bin/sh\n", "utf8");
      await fs.chmod(npmCommand, 0o755);

      await expect(
        resolvePackageRuntimeNpmInvocation({
          nodePath,
          fallbackCommand: npmCommand,
        }),
      ).resolves.toBeNull();
    });
  });

  it.skipIf(process.platform === "win32")(
    "prefers the canonical npm symlink target over a stale inferred neighbor",
    async () => {
      await withTempDir({ prefix: "openclaw-package-runtime-npm-link-" }, async (base) => {
        const nodePath = path.join(base, "service", "node");
        const npmCommand = path.join(base, "prefix", "bin", "npm");
        const canonicalNpmCli = path.join(base, "canonical", "npm-cli.js");
        const staleNpmCli = path.join(
          base,
          "prefix",
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        );
        await fs.mkdir(path.dirname(npmCommand), { recursive: true });
        await fs.mkdir(path.dirname(canonicalNpmCli), { recursive: true });
        await fs.mkdir(path.dirname(staleNpmCli), { recursive: true });
        await fs.writeFile(canonicalNpmCli, "#!/usr/bin/env node\n", "utf8");
        await fs.chmod(canonicalNpmCli, 0o755);
        await fs.writeFile(staleNpmCli, "", "utf8");
        await fs.symlink(canonicalNpmCli, npmCommand);

        await expect(
          resolvePackageRuntimeNpmInvocation({
            nodePath,
            fallbackCommand: npmCommand,
          }),
        ).resolves.toEqual([nodePath, canonicalNpmCli]);
      });
    },
  );
});
