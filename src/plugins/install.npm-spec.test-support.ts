import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { installPluginFromNpmSpec } from "./install.js";
import { packPlugins, type RegistryPackage } from "./test-helpers/npm-registry-fixtures.js";

const installedPackageTreePolicySource = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.sourcePathKind === "directory") {
    process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      decision: "block",
      reason: "blocked installed package tree",
    }));
    return;
  }
  process.stdout.write(JSON.stringify({ protocolVersion: 1, decision: "allow" }));
});
`;

export async function createInstalledPackageTreePolicyExec(rootDir: string) {
  if (process.platform === "win32") {
    return { command: process.execPath, args: ["-e", installedPackageTreePolicySource] };
  }
  const command = path.join(rootDir, "install-policy.cjs");
  await fs.writeFile(command, `#!${process.execPath}\n${installedPackageTreePolicySource}`, "utf8");
  await fs.chmod(command, 0o700);
  return { command, args: [] };
}

export function configWithInstalledPackageTreeBlockPolicy(exec: {
  command: string;
  args: string[];
}): OpenClawConfig {
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: {
          source: "exec",
          command: exec.command,
          args: exec.args,
          timeoutMs: 5000,
          maxOutputBytes: 16 * 1024,
        },
      },
    },
  };
}

export async function installProjectDependencies(
  projectRoot: string,
  dependencies: Record<string, string>,
): Promise<void> {
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
    "utf8",
  );
  await promisify(execFile)(
    "npm",
    [
      "install",
      "--omit=dev",
      "--omit=peer",
      "--legacy-peer-deps",
      "--loglevel=error",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: projectRoot },
  );
}

export async function installNpmPlugin(params: {
  config?: OpenClawConfig;
  expectedIntegrity?: string;
  npmRoot: string;
  spec: string;
}) {
  return await installPluginFromNpmSpec({
    ...(params.config ? { config: params.config } : {}),
    ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
    spec: params.spec,
    npmDir: params.npmRoot,
    logger: { info: () => {}, warn: () => {} },
    timeoutMs: 120_000,
  });
}

export function registerNpmPayloadIdentityTests({
  makeInstallFixture,
  uniquePackageName,
  useStaticRegistry,
}: {
  makeInstallFixture: (label: string) => Promise<{ rootDir: string; npmRoot: string }>;
  uniquePackageName: (prefix: string) => string;
  useStaticRegistry: (packages: RegistryPackage[]) => Promise<string>;
}) {
  it.each(["version", "name", "matching", "normalized-version", "loose-version"] as const)(
    "checks real npm payload %s against the selected registry identity",
    { timeout: 120_000 },
    async (identity) => {
      const { rootDir, npmRoot } = await makeInstallFixture("npm-payload-identity-e2e");
      const packageName = uniquePackageName("payload-identity");
      const pluginId = "payload-identity";
      const payloadName = identity === "name" ? uniquePackageName("other-payload") : packageName;
      const payloadVersion = {
        version: "1.9.0",
        name: "2.0.0",
        matching: "2.0.0",
        "normalized-version": "v2.0.0",
        "loose-version": "02.0.0",
      }[identity];
      const versions = await packPlugins(rootDir, [
        { packageName, version: "1.0.0", pluginId },
        {
          packageName: payloadName,
          version: payloadVersion,
          pluginId,
        },
      ]);
      for (const [index, entry] of versions.entries()) {
        if (index === 1) {
          entry.version = "2.0.0";
        }
      }
      await useStaticRegistry([
        {
          packageName,
          latest: "2.0.0",
          versions,
        },
      ]);
      const original = await installNpmPlugin({ spec: `${packageName}@1.0.0`, npmRoot });
      if (!original.ok) {
        throw new Error(original.error);
      }
      const manifestPath = path.join(original.targetDir, "package.json");
      const originalManifest = await fs.readFile(manifestPath, "utf8");
      const projectsRoot = path.join(npmRoot, "projects");
      const originalProjects = (await fs.readdir(projectsRoot)).toSorted();
      const beforeCommit = vi.fn(async () => {});

      const result = await installPluginFromNpmSpec({
        spec: `${packageName}@2.0.0`,
        expectedPluginId: pluginId,
        npmDir: npmRoot,
        mode: "update",
        onBeforePluginArtifactCommit: beforeCommit,
        logger: { info: () => {}, warn: () => {} },
        timeoutMs: 120_000,
      });

      expect(await fs.readFile(manifestPath, "utf8")).toBe(originalManifest);
      if (identity !== "version" && identity !== "name") {
        expect(result).toMatchObject({
          ok: true,
          pluginId,
          manifestName: packageName,
          version: payloadVersion,
          npmResolution: { name: packageName, version: "2.0.0" },
        });
        expect(beforeCommit).toHaveBeenCalledOnce();
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.error).toMatch(/expected/i);
        expect(result.error).toContain(identity === "version" ? "1.9.0" : payloadName);
        expect(result.error).toContain(identity === "version" ? "2.0.0" : packageName);
        expect(beforeCommit).not.toHaveBeenCalled();
        expect((await fs.readdir(projectsRoot)).toSorted()).toEqual(originalProjects);
      }
    },
  );
}
