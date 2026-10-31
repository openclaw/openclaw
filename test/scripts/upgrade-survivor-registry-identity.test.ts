import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { writePluginInstallIndexForE2E } from "../../scripts/e2e/lib/plugin-index-sqlite.mjs";
import { packToArchive } from "../../src/plugins/test-helpers/archive-fixtures.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveWorkflowBash } from "../helpers/workflow-bash.js";
import { writeJson } from "./upgrade-survivor-io.test-support.js";
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

async function tarball(
  root: string,
  filename: string,
  name: string,
  version: string,
  bytes: string,
  outputDir = root,
) {
  const staging = join(root, `${filename}-source`);
  mkdirSync(join(staging, "package"), { recursive: true });
  writeJson(join(staging, "package/package.json"), { name, version });
  writeFileSync(join(staging, "package/build.txt"), bytes);
  return packToArchive({ pkgDir: join(staging, "package"), outDir: outputDir, outName: filename });
}

async function expectArchive(url: string, archive: string) {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(archive));
}

async function registryPackage(url: string, name: string, version: string, archive: string) {
  const response = await fetch(`${url}/${encodeURIComponent(name).replace("%40", "@")}`);
  const metadata = await response.json();
  expect(metadata).toMatchObject({
    "dist-tags": { latest: version },
    versions: { [version]: { dist: { integrity: integrity(archive) } } },
  });
  await expectArchive(metadata.versions[version].dist.tarball, archive);
  return metadata.versions;
}

function installRecord(name: string, version: string, archive: string, installPath?: string) {
  return {
    source: "npm",
    spec: `${name}@latest`,
    resolvedName: name,
    resolvedVersion: version,
    integrity: integrity(archive),
    ...(installPath ? { installPath } : {}),
  };
}

it.for([
  { scenario: "legacy-operator-state", version: BASELINE },
  { scenario: "legacy-operator-state", version: "2026.9.6" },
  { scenario: "base", version: BASELINE },
  { scenario: "base", version: "2026.9.6" },
])(
  "preserves installed published registry bytes for $scenario while selecting candidate $version",
  async ({ scenario, version }, { signal }) => {
    const root = tempDirs.make("upgrade-survivor-registry-identity-");
    const artifact = join(root, "artifact");
    const bin = join(root, "bin");
    mkdirSync(artifact);
    mkdirSync(bin);
    const packages = [];
    for (const id of scenario === "base" ? ["codex", "discord", "whatsapp"] : ["discord"]) {
      const name = `@openclaw/${id}`;
      const published = await tarball(
        root,
        `${id}-published.tgz`,
        name,
        BASELINE,
        "published bytes",
      );
      const candidate = await tarball(
        root,
        `${id}-candidate.tgz`,
        name,
        version,
        "candidate bytes",
        artifact,
      );
      expect(integrity(candidate)).not.toBe(integrity(published));
      packages.push({ id, name, published, candidate });
    }
    const core = await tarball(root, "core.tgz", "openclaw", version, "candidate core");
    const manifest = join(artifact, "prepublish-plugin-registry.json");
    writeJson(manifest, {
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
    });
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
printf 'registry-stage baseline %s\\n' "\${NPM_CONFIG_REGISTRY:-upstream}"
read -r next_stage
openclaw_e2e_stop_process "$plugin_registry_pid"
plugin_registry_pid=""
configure_plugin_registry
printf '%s\\n' "\${published_plugin_registry_args[@]-}" > "$FIXTURE_ROOT/published-paths"
printf '%s' "\${baseline_plugin_tarball:-}" > "$FIXTURE_ROOT/published-path"
printf 'registry-stage candidate %s\\n' "$NPM_CONFIG_REGISTRY"
read -r done
`,
    );
    const child = spawn(resolveWorkflowBash(), [shell], { env, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
    }
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
        const prefix = `registry-stage ${stage} `;
        while (true) {
          const line = await withinTest(
            awaitGateBeforeSettlement(
              iterator.next(),
              closed,
              "Registry exited before stage receipt",
            ),
            signal,
          );
          if (line.done) {
            throw new Error("Registry stdout closed before stage receipt");
          }
          if (line.value.startsWith(prefix)) {
            return line.value.slice(prefix.length);
          }
        }
      } catch (cause) {
        throw new Error(`Registry ${stage} startup failed:\n${output}`, { cause });
      }
    };
    try {
      const baselineUrl = await waitForStage("baseline");
      if (scenario === "legacy-operator-state") {
        const companion = packages[0];
        assert(companion, "Missing published companion fixture");
        const { name, published } = companion;
        await registryPackage(baselineUrl, name, BASELINE, published);
      }
      writePluginInstallIndexForE2E(
        {
          installRecords: Object.fromEntries(
            packages.map(({ id, name, published }) => [
              id,
              installRecord(name, BASELINE, published),
            ]),
          ),
        },
        { stateDir: state },
      );
      child.stdin.write("candidate\n");
      const candidateUrl = await waitForStage("candidate");
      const publishedPaths = readFileSync(join(root, "published-paths"), "utf8").trim().split("\n");
      for (const { id, name, published, candidate } of packages) {
        const selected = version === BASELINE ? published : candidate;
        const versions = await registryPackage(candidateUrl, name, version, selected);
        expect(versions[version]).toMatchObject({ name, version });
        if (scenario === "legacy-operator-state" && version !== BASELINE) {
          await expectArchive(versions[BASELINE].dist.tarball, published);
        }

        const installPath = join(state, `npm/projects/fixture/node_modules/${name}`);
        mkdirSync(installPath, { recursive: true });
        writeJson(join(installPath, "package.json"), { name, version });
        const writeRecord = (archive: string) =>
          writePluginInstallIndexForE2E(
            {
              installRecords: {
                [id]: installRecord(name, version, archive, installPath),
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
      expect(await withinTest(closed, signal), output).toBe(0);
    } finally {
      await stop();
      lines.close();
    }
  },
);
