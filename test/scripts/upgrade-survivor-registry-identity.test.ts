import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { writePluginInstallIndexForE2E } from "../../scripts/e2e/lib/plugin-index-sqlite.mjs";
import { waitForFixtureFile } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveWorkflowBash } from "../helpers/workflow-bash.js";
import { readUpgradeSurvivorPaths } from "./upgrade-survivor-paths.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const BASELINE = "2026.9.5";
const PACKAGE = "@openclaw/discord";
const SOURCE_SHA = "a".repeat(40);
const RUNNER = "scripts/e2e/lib/upgrade-survivor/run.sh";
const ASSERTIONS = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");
const digest = (file: string, algorithm: "sha256" | "sha512") =>
  createHash(algorithm)
    .update(readFileSync(file))
    .digest(algorithm === "sha256" ? "hex" : "base64");
const integrity = (file: string) => `sha512-${digest(file, "sha512")}`;

function tarball(
  root: string,
  filename: string,
  name: string,
  version: string,
  bytes: string,
  outputDir = root,
) {
  const staging = join(root, `${filename}-source`);
  mkdirSync(join(staging, "package"), { recursive: true });
  writeFileSync(join(staging, "package/package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(staging, "package/build.txt"), bytes);
  execFileSync("tar", ["-czf", filename, "-C", staging, "package"], { cwd: outputDir });
  return join(outputDir, filename);
}

async function expectArchive(url: string, archive: string) {
  const response = await fetch(`${url}/@openclaw%2Fdiscord/-/${basename(archive)}`);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(archive));
}

it.each([BASELINE, "2026.9.6"])(
  "preserves published registry bytes while selecting candidate %s",
  async (version) => {
    const root = tempDirs.make("upgrade-survivor-registry-identity-");
    const artifact = join(root, "artifact");
    const bin = join(root, "bin");
    mkdirSync(artifact);
    mkdirSync(bin);
    const published = tarball(root, "published.tgz", PACKAGE, BASELINE, "published bytes");
    const candidate = tarball(root, "candidate.tgz", PACKAGE, version, "candidate bytes", artifact);
    const core = tarball(root, "core.tgz", "openclaw", version, "candidate core");
    expect(integrity(candidate)).not.toBe(integrity(published));
    const manifest = join(artifact, "prepublish-plugin-registry.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        schema: "openclaw.prepublish-plugin-registry/v1",
        schemaVersion: 1,
        sourceSha: SOURCE_SHA,
        candidateVersion: version,
        packages: [
          { name: PACKAGE, version, tarball: "candidate.tgz", sha256: digest(candidate, "sha256") },
        ],
      }),
    );
    const npm = join(bin, "npm");
    writeFileSync(
      npm,
      `#!${process.execPath}
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const [command, spec, ...args] = process.argv.slice(2);
assert.equal(spec, "${PACKAGE}@${BASELINE}");
if (command === "view") process.stdout.write(JSON.stringify("${BASELINE}"));
else if (command === "pack") {
  fs.copyFileSync(process.env.FIXTURE_PUBLISHED, path.join(args[args.indexOf("--pack-destination") + 1], "published.tgz"));
  process.stdout.write("published.tgz\\n");
} else throw new Error("Unexpected npm acquisition: " + command);
`,
    );
    chmodSync(npm, 0o755);
    const paths = readUpgradeSurvivorPaths(root, {
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "legacy-operator-state",
    });
    const env = {
      ...process.env,
      ...paths.env,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE: `openclaw@${BASELINE}`,
      OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC: core,
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "0",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: artifact,
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: digest(manifest, "sha256"),
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: SOURCE_SHA,
      OPENCLAW_NPM_REGISTRY_UPSTREAM: "http://127.0.0.1:1",
      OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM: "0",
      OPENCLAW_NPM_REGISTRY_BIND_HOST: "127.0.0.1",
      OPENCLAW_NPM_REGISTRY_PORT: "0",
      FIXTURE_ROOT: root,
      FIXTURE_PUBLISHED: published,
      PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      BASH_ENV: "",
      ENV: "",
    };
    const source = readFileSync(RUNNER, "utf8");
    const firstPhase = source.indexOf("\nphase storage-preflight");
    expect(firstPhase).toBeGreaterThan(0);
    const shell = join(root, "registry-stages.sh");
    writeFileSync(
      shell,
      `${source.slice(0, firstPhase)}
trap - ERR EXIT HUP INT TERM
trap 'openclaw_e2e_stop_process "\${plugin_registry_pid:-}"' EXIT
baseline_version="${BASELINE}"
candidate_version="${version}"
configure_plugin_registry baseline
printf '%s' "$NPM_CONFIG_REGISTRY" > "$FIXTURE_ROOT/baseline-url"
read -r next_stage
openclaw_e2e_stop_process "$plugin_registry_pid"
plugin_registry_pid=""
configure_plugin_registry
printf '%s' "\${baseline_plugin_tarball:-}" > "$FIXTURE_ROOT/published-path"
printf '%s' "$NPM_CONFIG_REGISTRY" > "$FIXTURE_ROOT/candidate-url"
read -r done
`,
    );
    const child = spawn(resolveWorkflowBash(), [shell], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const closed = new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveExit(code));
    });
    const stop = async () => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
      await closed;
    };
    onTestFinished(stop);
    const waitForStage = async (stage: "baseline" | "candidate") => {
      try {
        await waitForFixtureFile(join(root, `${stage}-url`), closed);
      } catch (cause) {
        throw new Error(`Registry ${stage} startup failed:\n${output}`, { cause });
      }
    };
    try {
      await waitForStage("baseline");
      const baselineUrl = readFileSync(join(root, "baseline-url"), "utf8");
      const metadata = await fetch(`${baselineUrl}/@openclaw%2Fdiscord`);
      expect(await metadata.json()).toMatchObject({
        "dist-tags": { latest: BASELINE },
        versions: { [BASELINE]: { dist: { integrity: integrity(published) } } },
      });
      await expectArchive(baselineUrl, published);
      child.stdin.write("candidate\n");
      await waitForStage("candidate");
      const candidateUrl = readFileSync(join(root, "candidate-url"), "utf8");
      const selected = version === BASELINE ? published : candidate;
      const updatedMetadata = await fetch(`${candidateUrl}/@openclaw%2Fdiscord`);
      expect(await updatedMetadata.json()).toMatchObject({
        "dist-tags": { latest: version },
        versions: {
          [BASELINE]: {
            name: PACKAGE,
            version: BASELINE,
            dist: { integrity: integrity(published) },
          },
          [version]: { name: PACKAGE, version, dist: { integrity: integrity(selected) } },
        },
      });
      await expectArchive(candidateUrl, published);
      if (version !== BASELINE) {
        await expectArchive(candidateUrl, candidate);
      }

      const state = join(root, "state");
      const installPath = join(state, "npm/projects/fixture/node_modules/@openclaw/discord");
      mkdirSync(installPath, { recursive: true });
      writeFileSync(join(installPath, "package.json"), JSON.stringify({ name: PACKAGE, version }));
      const writeRecord = (archive: string) =>
        writePluginInstallIndexForE2E(
          {
            installRecords: {
              discord: {
                source: "npm",
                spec: `${PACKAGE}@latest`,
                resolvedName: PACKAGE,
                resolvedVersion: version,
                installPath,
                integrity: integrity(archive),
              },
            },
          },
          { stateDir: state },
        );
      const retained =
        version === BASELINE ? readFileSync(join(root, "published-path"), "utf8") : "";
      const assertInstall = () =>
        spawnSync(
          process.execPath,
          [
            ASSERTIONS,
            "assert-npm-plugin-install",
            "discord",
            PACKAGE,
            version,
            "0",
            "",
            "",
            "",
            retained,
          ],
          {
            encoding: "utf8",
            env: {
              ...env,
              OPENCLAW_STATE_DIR: state,
              OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
            },
          },
        );
      writeRecord(selected);
      const valid = assertInstall();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      writeRecord(version === BASELINE ? candidate : published);
      const wrongBytes = assertInstall();
      expect(wrongBytes.status).toBe(1);
      expect(wrongBytes.stderr).toContain("discord plugin registry artifact integrity changed");
      child.stdin.end("done\n");
      expect(await closed, output).toBe(0);
    } finally {
      await stop();
    }
  },
);
