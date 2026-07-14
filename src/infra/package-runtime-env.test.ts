import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  createPackageRuntimeEnv,
  resolvePackageRuntimeNpmInvocation,
  resolvePackageRuntimeNpmPrefix,
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
  });

  it("derives npm prefixes from adjacent commands and explicit CLI runners", () => {
    expect(resolvePackageRuntimeNpmPrefix(["/opt/node/bin/npm"])).toBe("/opt/node");
    expect(
      resolvePackageRuntimeNpmPrefix([
        "/service/bin/node",
        "/owner/lib/node_modules/npm/bin/npm-cli.js",
      ]),
    ).toBe("/owner");
    expect(
      resolvePackageRuntimeNpmPrefix([
        "C:\\Service\\node.exe",
        "C:\\Owner\\node_modules\\npm\\bin\\npm-cli.js",
      ]),
    ).toBe("C:\\Owner");
    expect(
      resolvePackageRuntimeNpmPrefix([
        "C:\\Service\\node.exe",
        "C:\\tools\\lib\\node_modules\\npm\\bin\\npm-cli.js",
      ]),
    ).toBe("C:\\tools\\lib");
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

  it("keeps the owning npm CLI when selected Node has a different adjacent npm", async () => {
    await withTempDir({ prefix: "openclaw-package-runtime-owning-npm-" }, async (base) => {
      const nodePath = path.join(base, "service", "bin", "node");
      const adjacentNpm = path.join(base, "service", "bin", "npm");
      const owningNpm = path.join(base, "owner", "bin", "npm");
      const owningNpmCli = path.join(
        base,
        "owner",
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      await Promise.all([
        fs.mkdir(path.dirname(adjacentNpm), { recursive: true }),
        fs.mkdir(path.dirname(owningNpm), { recursive: true }),
        fs.mkdir(path.dirname(owningNpmCli), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(adjacentNpm, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 }),
        fs.writeFile(owningNpm, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 }),
        fs.writeFile(owningNpmCli, "", "utf8"),
      ]);

      await expect(
        resolvePackageRuntimeNpmInvocation({
          nodePath,
          fallbackCommand: owningNpm,
        }),
      ).resolves.toEqual([nodePath, owningNpmCli]);
    });
  });

  it("uses adjacent npm for a known staged target when the fallback shim is opaque", async () => {
    await withTempDir({ prefix: "openclaw-package-runtime-opaque-npm-" }, async (base) => {
      const nodePath = path.join(base, "service", "bin", "node");
      const adjacentNpm = path.join(base, "service", "bin", "npm");
      const opaqueNpm = path.join(base, "shims", "npm");
      await Promise.all([
        fs.mkdir(path.dirname(adjacentNpm), { recursive: true }),
        fs.mkdir(path.dirname(opaqueNpm), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(adjacentNpm, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 }),
        fs.writeFile(opaqueNpm, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 }),
      ]);

      await expect(
        resolvePackageRuntimeNpmInvocation({
          nodePath,
          fallbackCommand: opaqueNpm,
          allowAdjacentFallback: true,
        }),
      ).resolves.toEqual([adjacentNpm]);
      await expect(
        resolvePackageRuntimeNpmInvocation({
          nodePath,
          fallbackCommand: opaqueNpm,
          allowAdjacentFallback: false,
        }),
      ).resolves.toBeNull();
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
