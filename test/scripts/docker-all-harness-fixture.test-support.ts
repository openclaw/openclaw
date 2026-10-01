import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyDockerSchedulerHarness } from "./docker-all-harness.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const preparedArchives = new Map<string, Buffer>();
let fixturePnpm: string | undefined;

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function writePackageArchive(
  packageDir: string,
  tarball: string,
  manifest: { name: string; version: string },
) {
  const key = JSON.stringify(manifest);
  let archive = preparedArchives.get(key);
  if (!archive) {
    writeJson(path.join(packageDir, "package.json"), manifest);
    archive = execFileSync("tar", ["-czf", "-", "-C", path.dirname(packageDir), "package"]);
    preparedArchives.set(key, archive);
  }
  // Share immutable bytes, while each case retains its own writable package artifact.
  writeFileSync(tarball, archive);
}

export function setupFixture(
  mode: "split" | "override" | "local",
  missingTargetScript = false,
  corepack = false,
  makeTempDir: typeof tempDirs.make = (prefix, root) => tempDirs.make(prefix, root),
) {
  const artifactRoot = path.resolve(".artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  const root = realpathSync(makeTempDir("docker-harness-", artifactRoot));
  const target = path.join(root, "frozen pnpm target");
  mkdirSync(target);
  const harness = mode === "local" ? target : path.join(target, ".release-harness");
  const selectedHarness =
    mode === "override" ? path.join(root, "operator's $& pnpm harness") : harness;
  copyDockerSchedulerHarness(harness);
  if (selectedHarness !== harness) {
    mkdirSync(selectedHarness, { recursive: true });
  }
  const marker = path.join(root, "calls.jsonl");
  const poison = path.join(root, "target-ran");
  const toolchainMarker = path.join(root, "toolchains.jsonl");
  const version = "2026.8.1";
  const packageDir = path.join(root, "packed", "package");
  const tarball = path.join(root, "frozen candidate.tgz");
  writePackageArchive(packageDir, tarball, { name: "openclaw", version });
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const trustedScript = `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
  lane: process.env.OPENCLAW_DOCKER_ALL_LANE_NAME,
  cwd: process.cwd(),
  phase: process.argv[2],
  skipDockerBuild: process.env.OPENCLAW_SKIP_DOCKER_BUILD,
  registry: process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR,
  registryVersion: process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION,
  registrySha256: process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256,
  target: process.env.OPENCLAW_DOCKER_E2E_REPO_ROOT,
  harness: process.env.OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR,
  liveTarget: process.env.OPENCLAW_LIVE_DOCKER_REPO_ROOT,
  package: process.env.OPENCLAW_CURRENT_PACKAGE_TGZ,
  sha256: process.env.OPENCLAW_CURRENT_PACKAGE_SHA256,
  selectedSha: process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA,
  cache: process.env.OPENCLAW_DOCKER_CACHE_HOME_DIR,
  tools: process.env.OPENCLAW_DOCKER_CLI_TOOLS_DIR,
}) + '\\n');
`;
  const poisonedScript = `require('node:fs').writeFileSync(${JSON.stringify(poison)}, 'old harness'); process.exit(47);`;
  for (const [dir, script] of [
    [target, poisonedScript],
    [selectedHarness, trustedScript],
  ] as const) {
    const scriptsDir = path.join(dir, "scripts");
    mkdirSync(path.join(scriptsDir, "e2e"), { recursive: true });
    writeFileSync(path.join(dir, "marker.cjs"), script);
    for (const leaf of [
      "e2e/gateway-concurrency-docker.sh",
      "test-live-models-docker.sh",
      "test-live-build-docker.sh",
    ]) {
      writeFileSync(
        path.join(scriptsDir, leaf),
        `#!/usr/bin/env bash\nexec node ${quote(path.join(dir, "marker.cjs"))} ${leaf === "test-live-build-docker.sh" ? "live-build" : ""}\n`,
      );
    }
    writeJson(path.join(dir, "package.json"), {
      name: "openclaw",
      version,
      ...(corepack && {
        packageManager: dir === selectedHarness ? "pnpm@11.22.0" : "pnpm@12.0.0",
      }),
      scripts:
        dir === target && missingTargetScript
          ? {}
          : {
              "test:docker:gateway-network": "node marker.cjs",
              "test:docker:package-install": "node marker.cjs",
              "test:docker:cli-installer-distribution": "node marker.cjs",
              "test:docker:e2e-build": "node marker.cjs package-image",
              "test:docker:cleanup": "node marker.cjs cleanup",
              "test:docker:all": `node ${quote(path.join(harness, "scripts/test-docker-all.mjs"))}`,
            },
    });
    // Keep pnpm in this miniature workspace, away from the host repo's toolchain pin.
    writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  }
  execFileSync("git", ["init", "-q"], { cwd: target });
  execFileSync("git", ["add", "package.json"], { cwd: target });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "candidate"],
    { cwd: target },
  );
  const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: target,
    encoding: "utf8",
  }).trim();
  const registry = path.join(root, "frozen registry");
  mkdirSync(registry);
  const pluginTarball = path.join(registry, "codex.tgz");
  writePackageArchive(packageDir, pluginTarball, { name: "@openclaw/codex", version });
  const registryManifest = path.join(registry, "prepublish-plugin-registry.json");
  writeJson(registryManifest, {
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha: selectedSha,
    candidateVersion: version,
    packages: [
      {
        name: "@openclaw/codex",
        version,
        tarball: "codex.tgz",
        sha256: createHash("sha256").update(readFileSync(pluginTarball)).digest("hex"),
      },
    ],
  });
  const registrySha256 = createHash("sha256").update(readFileSync(registryManifest)).digest("hex");
  const pnpm = (fixturePnpm ??= execFileSync("bash", ["-c", "command -v pnpm"], {
    encoding: "utf8",
  }).trim());
  const pinnedPnpm = path.join(root, "pinned '$& pnpm wrapper");
  // Corepack Engine.executePackageManagerRequest resolves findProjectSpec(cwd)
  // before runVersion forwards argv. pnpm then checks its effective project's pin.
  // Model only that offline boundary; package scripts still execute as real children.
  writeFileSync(
    pinnedPnpm,
    corepack
      ? `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const manifest = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
const selected = manifest(process.cwd()).packageManager;
const args = process.argv.slice(2);
const cwd = args[0] === '--dir' ? args.splice(0, 2)[1] : process.cwd();
const project = manifest(cwd);
fs.appendFileSync(${JSON.stringify(toolchainMarker)}, JSON.stringify({ cwd: process.cwd(), selected, required: project.packageManager }) + '\\n');
if (selected !== project.packageManager) {
  console.error('ERR_PNPM_BAD_PM_VERSION: Corepack selected ' + selected + ' before --dir; project requires ' + project.packageManager);
  process.exit(1);
}
const result = spawnSync(project.scripts[args[0]], { cwd, shell: true, stdio: 'inherit' });
process.exit(result.status ?? 1);
`
      : `#!/usr/bin/env bash\nexec ${quote(pnpm)} "$@"\n`,
  );
  chmodSync(pinnedPnpm, 0o755);
  return {
    root,
    target,
    harness,
    selectedHarness,
    marker,
    poison,
    tarball,
    sha256,
    selectedSha,
    pinnedPnpm,
    registry,
    registrySha256,
    toolchainMarker,
  };
}
