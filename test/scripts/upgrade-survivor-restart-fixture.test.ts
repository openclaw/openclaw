import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { writePluginInstallIndexForE2E } from "../../scripts/e2e/lib/plugin-index-sqlite.mjs";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.10.5";
const futureVersion = "2026.10.6-first-hop.0";
const sourceSha = "a".repeat(40);
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const source = fs.readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
const prepare = source.slice(
  source.indexOf("prepare_restart_fixture() {"),
  source.indexOf("repair_update_restart_auth() {"),
);

function json(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fixture() {
  const root = dirs.make("survivor-restart-cohort-");
  const registry = path.join(root, "sealed");
  fs.mkdirSync(registry);
  const packages = [
    "@openclaw/codex",
    "@openclaw/discord",
    "@openclaw/matrix",
    "@openclaw/whatsapp",
    "openclaw",
  ].map((name) => {
    const build = { openclawVersion: version, bundledDist: false };
    const manifest = {
      name,
      version,
      dependencies: { "fixture-dependency": "1.0.0" },
      openclaw: {
        build,
        compat: { pluginApi: ">=2026.10.5" },
        schemaVersions: { state: 1, agent: 1 },
      },
    };
    const unpacked = path.join(root, name.replace("/", "-"));
    json(path.join(unpacked, "package/package.json"), manifest);
    fs.writeFileSync(
      path.join(unpacked, "package/index.js"),
      "export const payload = 'unchanged';\n",
    );
    if (name === "openclaw") {
      json(path.join(unpacked, "package/dist/build-info.json"), { version });
      json(path.join(unpacked, "package/dist/update-compat-inventory.json"), {
        releases: [{ chunks: [] }],
      });
      json(path.join(unpacked, "package/dist/postinstall-inventory.json"), [
        "dist/build-info.json",
      ]);
    }
    const tarball = name.replace("@", "").replace("/", "-") + ".tgz";
    const file = path.join(registry, tarball);
    execFileSync("tar", ["-czf", file, "-C", unpacked, "package"]);
    return { name, version, tarball, sha256: hash(file) };
  });
  const manifest = path.join(registry, "prepublish-plugin-registry.json");
  json(manifest, {
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha,
    candidateVersion: version,
    packages,
  });
  const config = path.join(root, "config.json");
  // The persisted index owns installs after migration; stale config must not grow the cohort.
  json(config, {
    plugins: { installs: { matrix: { source: "npm", resolvedName: "@openclaw/matrix" } } },
  });
  writePluginInstallIndexForE2E(
    {
      installRecords: Object.fromEntries(
        ["discord", "whatsapp", "missing-control"].map((id) => [
          id,
          {
            source: "npm",
            resolvedName: "@openclaw/" + id,
            resolvedVersion: version,
          },
        ]),
      ),
    },
    { stateDir: path.join(root, "state") },
  );
  return { root, registry, manifest, config, packages };
}

it.skipIf(process.platform === "win32")(
  "serves the active synthetic cohort without changing sealed candidates or filling missing controls",
  async ({ signal }) => {
    const { root, registry, manifest, config, packages } = fixture();
    const sealed = new Map(
      [manifest, ...packages.map((entry) => path.join(registry, entry.tarball))].map((file) => [
        file,
        hash(file),
      ]),
    );
    const upstream = spawn(
      process.execPath,
      [
        "scripts/e2e/lib/plugins/npm-registry-server.mjs",
        path.join(root, "upstream-port"),
        ...packages.flatMap((entry) => [
          entry.name,
          entry.version,
          path.join(registry, entry.tarball),
        ]),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH } },
    );
    const closed = once(upstream, "close");
    try {
      const [port] = await withinTest(
        awaitGateBeforeSettlement(
          once(upstream, "message"),
          closed,
          "registry exited before readiness",
        ),
        signal,
      );
      const script = `
set -euo pipefail
exec 3>&1
source scripts/e2e/lib/prepublish-plugin-registry.sh
source scripts/lib/openclaw-e2e-instance.sh
phase() { shift; "$@"; }
prepare_candidate_tarball() { :; }
COMMAND_TIMEOUT=10s
candidate_version=${version}
candidate_tarball="$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR/openclaw.tgz"
restart_registry_pid=""
trap 'kill "$restart_registry_pid" 2>/dev/null || true; wait 2>/dev/null || true' EXIT
${prepare}
prepare_restart_fixture
node --input-type=module - "$NPM_CONFIG_REGISTRY" "$ARTIFACT_ROOT" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const [registry, root] = process.argv.slice(2);
for (const name of ["@openclaw/codex", "@openclaw/discord", "@openclaw/whatsapp"]) {
  for (const version of ["2026.10.5", "2026.10.6-first-hop.0"]) {
    const response = await fetch(registry + "/" + encodeURIComponent(name) + "/" + version);
    assert.equal(response.status, 200, name + "@" + version + " must converge");
    const metadata = await response.json();
    assert.equal(metadata.version, version);
    assert.equal(metadata.openclaw.build.openclawVersion, version);
    const archive = await fetch(metadata.dist.tarball);
    assert.equal(archive.status, 200);
    const file = path.join(root, name.split("/").at(-1) + "-" + version + ".tgz");
    fs.writeFileSync(file, Buffer.from(await archive.arrayBuffer()));
  }
}
const redirected = await fetch(
  "https://registry.npmjs.org/%40openclaw%2Fdiscord/2026.10.6-first-hop.0",
);
assert.equal(redirected.status, 200, "public npm diagnostics must use the synthetic cohort");
assert.equal((await redirected.json()).version, "2026.10.6-first-hop.0");
for (const name of ["@openclaw/matrix", "@openclaw/missing-control"]) {
  const response = await fetch(registry + "/" + encodeURIComponent(name) + "/2026.10.6-first-hop.0");
  assert.equal(response.status, 404, "inactive/missing packages must stay unavailable");
  await response.body?.cancel();
}
NODE
`;
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          ARTIFACT_ROOT: root,
          RUNTIME_ROOT: root,
          NPM_CONFIG_REGISTRY: "http://127.0.0.1:" + port,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: config,
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry,
          OPENCLAW_DOCKER_E2E_SELECTED_SHA: sourceSha,
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: hash(manifest),
          NODE_OPTIONS:
            "--import=" +
            path.resolve("scripts/e2e/lib/upgrade-survivor/plugin-registry-redirect.mjs"),
          OPENCLAW_UPGRADE_SURVIVOR_NPM_REGISTRY: "http://127.0.0.1:" + port,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      for (const [file, digest] of sealed) {
        expect(hash(file)).toBe(digest);
      }
      for (const id of ["codex", "discord", "whatsapp"]) {
        const output = path.join(root, id + "-" + futureVersion + ".tgz");
        const member = (name: string) => execFileSync("tar", ["-xOf", output, "package/" + name]);
        const receiptPath = path.join(
          root,
          "restart-" + (id === "codex" ? "runtime" : id) + "-fixture.json",
        );
        const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
        expect(receipt).toMatchObject({
          name: "@openclaw/" + id,
          sourceVersion: version,
          targetVersion: futureVersion,
          sourceSha256: sealed.get(path.join(registry, "openclaw-" + id + ".tgz")),
          targetSha256: hash(output),
          members: {
            changes: [
              { path: "package.json", before: expect.any(String), after: expect.any(String) },
            ],
          },
        });
        const pluginManifest = JSON.parse(member("package.json").toString());
        expect(pluginManifest).toEqual({
          name: "@openclaw/" + id,
          version: futureVersion,
          dependencies: { "fixture-dependency": "1.0.0" },
          openclaw: {
            build: { openclawVersion: futureVersion, bundledDist: false },
            compat: { pluginApi: ">=2026.10.5" },
            schemaVersions: { state: 1, agent: 1 },
          },
        });
        expect(member("index.js").toString()).toBe("export const payload = 'unchanged';\n");
      }
    } finally {
      upstream.kill("SIGTERM");
      await closed;
    }
  },
);

it.skipIf(process.platform === "win32")(
  "retains the frozen extended-stable runtime CLI and its Codex-only source contract",
  () => {
    const { root, registry } = fixture();
    const run = (id: string, output: string) =>
      spawnSync(
        process.execPath,
        [
          "scripts/e2e/lib/update-first-hop-package-fixtures.mjs",
          "future-runtime-tarball",
          path.join(registry, "openclaw-" + id + ".tgz"),
          output,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH, TMPDIR: root } },
      );
    const runtime = run("codex", path.join(root, "runtime.tgz"));
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(JSON.parse(runtime.stdout)).toMatchObject({
      method: "candidate-same-schema-runtime-fixture",
      name: "@openclaw/codex",
      sourceVersion: version,
      targetVersion: futureVersion,
    });
    const rejectedOutput = path.join(root, "rejected.tgz");
    const wrongIdentity = run("discord", rejectedOutput);
    expect(wrongIdentity.status).not.toBe(0);
    expect(wrongIdentity.stderr).toContain("requires @openclaw/codex");
    expect(fs.existsSync(rejectedOutput)).toBe(false);
  },
);
