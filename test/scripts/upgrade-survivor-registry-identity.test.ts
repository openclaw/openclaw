import assert from "node:assert/strict";
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
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(archive));
}

it.each([
  { scenario: "legacy-operator-state", version: BASELINE },
  { scenario: "legacy-operator-state", version: "2026.9.6" },
  { scenario: "base", version: BASELINE },
  { scenario: "base", version: "2026.9.6" },
])(
  "preserves installed published registry bytes for $scenario while selecting candidate $version",
  async ({ scenario, version }) => {
    const root = tempDirs.make("upgrade-survivor-registry-identity-");
    const artifact = join(root, "artifact");
    const bin = join(root, "bin");
    mkdirSync(artifact);
    mkdirSync(bin);
    const packages = (scenario === "base" ? ["codex", "discord", "whatsapp"] : ["discord"]).map(
      (id) => {
        const name = `@openclaw/${id}`;
        const published = tarball(root, `${id}-published.tgz`, name, BASELINE, "published bytes");
        const candidate = tarball(
          root,
          `${id}-candidate.tgz`,
          name,
          version,
          "candidate bytes",
          artifact,
        );
        expect(integrity(candidate)).not.toBe(integrity(published));
        return { id, name, published, candidate };
      },
    );
    const core = tarball(root, "core.tgz", "openclaw", version, "candidate core");
    const manifest = join(artifact, "prepublish-plugin-registry.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        schema: "openclaw.prepublish-plugin-registry/v1",
        schemaVersion: 1,
        sourceSha: SOURCE_SHA,
        candidateVersion: version,
        packages: packages.map(({ name, candidate }) => ({
          name,
          version,
          tarball: basename(candidate),
          sha256: digest(candidate, "sha256"),
        })),
      }),
    );
    const npm = join(bin, "npm");
    writeFileSync(
      npm,
      `#!${process.execPath}
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const [command, spec, ...args] = process.argv.slice(2);
const published = ${JSON.stringify(Object.fromEntries(packages.map((entry) => [`${entry.name}@${BASELINE}`, entry.published])))};
assert.ok(published[spec], "Unexpected package: " + spec);
assert.ok(args.includes("--registry=https://registry.npmjs.org"));
if (command === "view") process.stdout.write(JSON.stringify("${BASELINE}"));
else if (command === "pack") {
  const filename = path.basename(published[spec]);
  fs.copyFileSync(published[spec], path.join(args[args.indexOf("--pack-destination") + 1], filename));
  process.stdout.write(args.includes("--json") ? JSON.stringify([{ filename }]) : filename + "\\n");
} else throw new Error("Unexpected npm acquisition: " + command);
`,
    );
    chmodSync(npm, 0o755);
    const paths = readUpgradeSurvivorPaths(root, {
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
    });
    const state = join(root, "state");
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
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
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
if [ "$SCENARIO" = legacy-operator-state ]; then configure_plugin_registry baseline; fi
printf '%s' "\${NPM_CONFIG_REGISTRY:-upstream}" > "$FIXTURE_ROOT/baseline-url"
read -r next_stage
openclaw_e2e_stop_process "$plugin_registry_pid"
plugin_registry_pid=""
configure_plugin_registry
printf '%s\\n' "\${published_plugin_registry_args[@]-}" > "$FIXTURE_ROOT/published-paths"
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
      if (scenario === "legacy-operator-state") {
        const companion = packages[0];
        assert(companion, "Missing published companion fixture");
        const { name, published } = companion;
        const metadata = await fetch(
          `${baselineUrl}/${encodeURIComponent(name).replace("%40", "@")}`,
        );
        const baselineMetadata = await metadata.json();
        expect(baselineMetadata).toMatchObject({
          "dist-tags": { latest: BASELINE },
          versions: { [BASELINE]: { dist: { integrity: integrity(published) } } },
        });
        await expectArchive(baselineMetadata.versions[BASELINE].dist.tarball, published);
      }
      writePluginInstallIndexForE2E(
        {
          installRecords: Object.fromEntries(
            packages.map(({ id, name, published }) => [
              id,
              {
                source: "npm",
                spec: `${name}@latest`,
                resolvedName: name,
                resolvedVersion: BASELINE,
                integrity: integrity(published),
              },
            ]),
          ),
        },
        { stateDir: state },
      );
      child.stdin.write("candidate\n");
      await waitForStage("candidate");
      const candidateUrl = readFileSync(join(root, "candidate-url"), "utf8");
      const publishedPaths = readFileSync(join(root, "published-paths"), "utf8").trim().split("\n");
      for (const { id, name, published, candidate } of packages) {
        const selected = version === BASELINE ? published : candidate;
        const updatedMetadata = await fetch(
          `${candidateUrl}/${encodeURIComponent(name).replace("%40", "@")}`,
        );
        const registryMetadata = await updatedMetadata.json();
        expect(registryMetadata).toMatchObject({
          "dist-tags": { latest: version },
          versions: { [version]: { name, version, dist: { integrity: integrity(selected) } } },
        });
        await expectArchive(registryMetadata.versions[version].dist.tarball, selected);
        if (scenario === "legacy-operator-state" && version !== BASELINE) {
          await expectArchive(registryMetadata.versions[BASELINE].dist.tarball, published);
        }

        const installPath = join(state, `npm/projects/fixture/node_modules/${name}`);
        mkdirSync(installPath, { recursive: true });
        writeFileSync(join(installPath, "package.json"), JSON.stringify({ name, version }));
        const writeRecord = (archive: string) =>
          writePluginInstallIndexForE2E(
            {
              installRecords: {
                [id]: {
                  source: "npm",
                  spec: `${name}@latest`,
                  resolvedName: name,
                  resolvedVersion: version,
                  installPath,
                  integrity: integrity(archive),
                },
              },
            },
            { stateDir: state },
          );
        const retained =
          version !== BASELINE
            ? ""
            : scenario === "legacy-operator-state"
              ? readFileSync(join(root, "published-path"), "utf8")
              : publishedPaths[publishedPaths.indexOf(name) + 2];
        assert(typeof retained === "string", `Missing retained archive for ${name}@${version}`);
        const assertInstall = () =>
          spawnSync(
            process.execPath,
            [ASSERTIONS, "assert-npm-plugin-install", id, name, version, "0", "", "", "", retained],
            { encoding: "utf8", env },
          );
        writeRecord(selected);
        const valid = assertInstall();
        expect(valid.status, valid.stdout + valid.stderr).toBe(0);
        writeRecord(version === BASELINE ? candidate : published);
        const wrongBytes = assertInstall();
        expect(wrongBytes.status).toBe(1);
        expect(wrongBytes.stderr).toContain(`${id} plugin registry artifact integrity changed`);
      }
      child.stdin.end("done\n");
      expect(await closed, output).toBe(0);
    } finally {
      await stop();
    }
  },
);
