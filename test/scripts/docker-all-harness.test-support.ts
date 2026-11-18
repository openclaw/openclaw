import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";

export function copyDockerSchedulerHarness(root: string) {
  const scriptsDir = path.join(root, "scripts");
  const libDir = path.join(scriptsDir, "lib");
  const upgradeSurvivorDir = path.join(scriptsDir, "e2e/lib/upgrade-survivor");
  mkdirSync(libDir, { recursive: true });
  mkdirSync(upgradeSurvivorDir, { recursive: true });
  copyFileSync(
    "scripts/e2e/lib/upgrade-survivor/installed-recovery-cases.mjs",
    path.join(upgradeSurvivorDir, "installed-recovery-cases.mjs"),
  );
  copyFileSync("package.json", path.join(root, "package.json"));
  copyFileSync("scripts/test-docker-all.mjs", path.join(scriptsDir, "test-docker-all.mjs"));
  copyFileSync("scripts/test-docker-all.mts", path.join(scriptsDir, "test-docker-all.mts"));
  copyFileSync("scripts/lib/tsx-cli-shim.mjs", path.join(libDir, "tsx-cli-shim.mjs"));
  copyFileSync("scripts/tsx.mjs", path.join(scriptsDir, "tsx.mjs"));
  copyFileSync("scripts/run-with-env.mts", path.join(scriptsDir, "run-with-env.mts"));
  copyFileSync(
    "scripts/prepublish-plugin-registry-artifact.mjs",
    path.join(scriptsDir, "prepublish-plugin-registry-artifact.mjs"),
  );
  copyFileSync("scripts/windows-cmd-helpers.mjs", path.join(scriptsDir, "windows-cmd-helpers.mjs"));
  for (const fileName of [
    "docker-e2e-plan.mts",
    "docker-e2e-scenarios.mts",
    "docker-e2e-container.sh",
    "docker-e2e-resource-diagnostics.sh",
    "local-check-runtime.mts",
    "numeric-options.mjs",
    "managed-child-process.mts",
    "managed-cleanup-handoff.mts",
    "vitest-resource-ownership.mts",
    "official-external-channel-catalog.json",
    "official-external-provider-catalog.json",
    "record-shared.mjs",
    "release-version.mjs",
    "update-compat-inventory.json",
    "update-first-hop-lanes.mjs",
    "sleep.mjs",
    "upgrade-survivor-policy.mjs",
    "upgrade-survivor-scenarios.json",
    "windows-taskkill.mjs",
  ]) {
    copyFileSync(path.join("scripts/lib", fileName), path.join(libDir, fileName));
  }
  copyFileSync(
    "scripts/e2e/lib/upgrade-survivor/config-recipe.mts",
    path.join(upgradeSurvivorDir, "config-recipe.mts"),
  );
  cpSync(
    "scripts/e2e/lib/upgrade-survivor/config-recipe",
    path.join(upgradeSurvivorDir, "config-recipe"),
    { recursive: true },
  );
  // Real release jobs install their TypeScript toolchain in the harness before execution.
  const modulesDir = path.join(root, "node_modules");
  mkdirSync(modulesDir);
  symlinkSync(
    realpathSync(path.join("node_modules", "tsx")),
    path.join(modulesDir, "tsx"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return scriptsDir;
}

export function packageArchiveBytes(packageDir: string): Buffer {
  // Sync tar buffers the complete tree; gzipSync closes its compressor before returning.
  const bytes = tar
    .c({ sync: true, cwd: path.dirname(packageDir) }, [path.basename(packageDir)])
    .read();
  assert(bytes);
  return gzipSync(bytes);
}

const preparedArchives = new Map<string, Buffer>();

export function writePackageTarball(
  root: string,
  name: string,
  version: string,
  fileName = "openclaw.tgz",
) {
  const manifest = { name, version };
  const key = JSON.stringify(manifest);
  let archive = preparedArchives.get(key);
  if (!archive) {
    const packageDir = path.join(root, `package-${fileName}`, "package");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(manifest));
    archive = packageArchiveBytes(packageDir);
    preparedArchives.set(key, archive);
  }
  // Only internally created manifest packages share bytes; each output remains writable.
  const tarball = path.join(root, fileName);
  writeFileSync(tarball, archive);
  return tarball;
}
