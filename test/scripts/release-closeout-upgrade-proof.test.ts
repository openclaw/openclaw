// Runner guard/settings/fixture tests only; these do NOT constitute real upgrade evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import {
  assertIdentity,
  assertLifecycle,
  assertOwnership,
  assertSettingsPreserved,
  assertStable,
  assertUpdate,
  lifecycleObserverSource,
  pluginManifestFixture,
  pluginSource,
  settingsFixture,
  verifyPair,
} from "../../scripts/release-closeout-upgrade-proof.mjs";

const head = "a".repeat(40),
  sha = "b".repeat(64),
  version = "2026.11.2";
test("ownership fixture explicitly activates and records only proven runtime ownership", () => {
  assert.deepEqual(pluginManifestFixture().activation, { onStartup: true });
  const parent = path.resolve(".openclaw/tmp");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "ownership-fixture-"));
  try {
    const state = path.join(dir, "operator-state");
    const plugin = path.join(dir, "operator-plugin");
    const source = path.join(dir, "operator-asset");
    const ledger = path.join(dir, "observations.jsonl");
    const privateState = path.join(dir, "openclaw-update-canary-test");
    const privatePlugin = path.join(privateState, "plugin");
    fs.mkdirSync(plugin);
    fs.mkdirSync(privatePlugin, { recursive: true });
    fs.writeFileSync(source, "release-closeout-external-asset\n");
    fs.symlinkSync(source, path.join(plugin, "config.txt"));
    fs.copyFileSync(source, path.join(privatePlugin, "config.txt"));
    const moduleFile = path.join(privatePlugin, "index.mjs");
    fs.writeFileSync(moduleFile, pluginSource({ plugin, source, state, ledger }));
    const invoke = () =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const {default: plugin} = await import(${JSON.stringify(moduleFile)}); plugin.register();`,
          "--",
          "--update-canary",
        ],
        { env: { ...process.env, OPENCLAW_STATE_DIR: privateState }, encoding: "utf8" },
      );
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    const observations = fs
      .readFileSync(ledger, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assertOwnership(observations);
    assert.equal(fs.readFileSync(source, "utf8"), "release-closeout-external-asset\n");
    assert.equal(
      fs.readFileSync(path.join(privatePlugin, "config.txt"), "utf8"),
      "release-closeout-external-asset\n",
    );
    fs.writeFileSync(source, "unexpected mutation");
    assert.notEqual(invoke().status, 0);
    assert.equal(fs.readFileSync(ledger, "utf8").trim().split("\n").length, 1);
    const diagnostics = fs
      .readFileSync(ledger + ".diagnostics.jsonl", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(diagnostics.some((record) => record.phase === "error"));
    assert.throws(() => assertOwnership(diagnostics));
    for (const override of [
      { surface: "doctor-contract" },
      { argv: [] },
      { privateWriteProven: false },
      { sourceUnchanged: false },
      { unrelatedAbsent: false },
    ]) {
      assert.throws(() => assertOwnership([{ ...observations[0], ...override }]));
    }
    // Doctor can prove the write first; runtime must observe that same private copy.
    assertOwnership([
      { ...observations[0], privateWriteProven: false },
      { ...observations[0], surface: "doctor-contract" },
    ]);
    assert.throws(() =>
      assertOwnership([
        { ...observations[0], privateWriteProven: false },
        { ...observations[0], surface: "doctor-contract", root: "/another-private-copy" },
      ]),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function proof(lane: "node" | "bun") {
  return {
    schema: 1,
    lane,
    status: "passed",
    head,
    candidateSha256: sha,
    baseline: { version, integrity: "sha512-test", tarball: "https://registry.npmjs.org/test.tgz" },
    build: { version, commit: head },
    assertions: {
      settingsPreserved: true,
      realUpdate: true,
      externalFilePrivateOwnership: true,
      postinstallGeneratedLauncher: true,
      nodeUnavailable: true,
    },
  };
}
test("Bun proof uses an init and actual Node absence without weakening isolation", () => {
  const workflow = fs.readFileSync(".github/workflows/release-closeout-proof.yml", "utf8");
  assert(workflow.includes("docker run --rm --init"));
  assert(workflow.includes("RUN rm -f /usr/local/bin/node /usr/local/bin/nodejs"));
  assert(!workflow.includes("node-unavailable"));
  assert(workflow.includes("--cap-drop ALL --security-opt no-new-privileges"));
  assert(workflow.includes('--user "$(id -u):$(id -g)"'));
  assert(workflow.includes("src=$bun_bin,dst=/proof-bun,readonly"));
});
test("settings fixture uses supported disabled scheduling and explicit plugin policy", () => {
  const config = settingsFixture({ workspace: "/proof/workspace", plugin: "/proof/plugin" });
  assert.deepEqual(config.agents, { defaults: { workspace: "/proof/workspace" } });
  assert.deepEqual(config.cron, { enabled: false });
  assert.equal(Object.hasOwn(config, "meta"), false);
  assert.deepEqual(config.plugins.allow, ["closeout-owner-proof", "skill-workshop"]);
  assert.equal(config.plugins.entries.codex.enabled, false);
});
test("every existing setting survives while new bookkeeping is allowed", () => {
  const before = settingsFixture({ workspace: "/proof/workspace", plugin: "/proof/plugin" });
  const after = structuredClone(before);
  Object.assign(after, { wizard: { lastRunCommand: "doctor" } });
  Object.assign(after, { meta: { migrations: { skillWorkshopPlugin: true } } });
  assertSettingsPreserved(before, after);
  const expandedAllowlist = structuredClone(after);
  expandedAllowlist.plugins.allow.push("unexpected-plugin");
  assert.throws(() => assertSettingsPreserved(before, expandedAllowlist));
  function checkSettings(value: object, keys: string[] = []) {
    for (const [key, setting] of Object.entries(value)) {
      const parts = [...keys, key];
      for (const replacement of [undefined, null, "changed", [], {}]) {
        const changed = structuredClone(after);
        let target: Record<string, unknown> = changed;
        for (const part of keys) {
          target = target[part] as Record<string, unknown>;
        }
        if (replacement === undefined) {
          delete target[key];
        } else {
          target[key] = replacement;
        }
        assert.throws(() => assertSettingsPreserved(before, changed), parts.join("."));
      }
      if (setting && typeof setting === "object" && !Array.isArray(setting)) {
        checkSettings(setting, parts);
      }
    }
  }
  checkSettings(before);
  assert.throws(() => assertSettingsPreserved({ empty: {} }, {}));
  assert.throws(() => assertSettingsPreserved({ empty: {} }, { empty: [] }));
  assert.throws(() => assertSettingsPreserved({ heartbeat: { every: "0m" } }, {}));
});
test("exact identities and stable-only baseline fail closed", () => {
  assertIdentity(head, sha);
  assert.throws(() => assertIdentity("a".repeat(12), sha));
  assert.throws(() => assertIdentity(head, "sha256-missing"));
  assertStable(version);
  for (const value of ["2026.9.36", "2026.11.2-beta.1", "latest", null]) {
    assert.throws(() => assertStable(value));
  }
});
test("a successful install is not sufficient without snapshot and canary", () => {
  const result = {
    status: "ok",
    after: { version },
    steps: [
      { name: "candidate-state-snapshot", exitCode: 0 },
      { name: "candidate-gateway-startup", exitCode: 0 },
    ],
  };
  assertUpdate(result, version);
  assert.throws(() => assertUpdate({ ...result, steps: [] }, version));
  assert.throws(() => assertUpdate({ ...result, steps: [result.steps[0]] }, version));
  assert.throws(() =>
    assertUpdate({ ...result, reason: "candidate-runtime-unavailable" }, version),
  );
  assert.throws(() => assertUpdate({ ...result, after: { version: "wrong" } }, version));
});
test("aggregate verdict requires both coherent complete lanes", () => {
  assert.equal(verifyPair(proof("node"), proof("bun"), head, sha).status, "passed");
  for (const key of [
    "settingsPreserved",
    "realUpdate",
    "postinstallGeneratedLauncher",
    "nodeUnavailable",
  ] as const) {
    const bun = proof("bun");
    bun.assertions[key] = false;
    assert.throws(() => verifyPair(proof("node"), bun, head, sha));
  }
  const moved = proof("bun");
  moved.baseline.version = "2026.11.3";
  assert.throws(() => verifyPair(proof("node"), moved, head, sha));
  const failed = proof("node");
  failed.status = "failed";
  assert.throws(() => verifyPair(failed, proof("bun"), head, sha));
  const wrong = proof("bun");
  wrong.head = "c".repeat(40);
  assert.throws(() => verifyPair(proof("node"), wrong, head, sha));
});
test("only a real staged postinstall receipt with generated shim and owned launcher qualifies", () => {
  const receipt = {
    event: "postinstall",
    phase: "exit",
    code: 0,
    packageVersion: version,
    cwd: "/stage/node_modules/openclaw",
    localPrefix: "/stage",
    path: [
      "/stage/node_modules/openclaw/node_modules/.bin",
      "/usr/bin",
      "/inherited/.ade21d781aa39b9e-1.node-gyp",
      "/inherited/bun-node-unrelated",
      "/tmp/.9d7a7447835bd8eb-3C.node-gyp",
      "/tmp/bun-node-0-191755ec1",
      "/stage/node_modules/node_modules/.bin",
      "/stage/node_modules/.bin",
      "/node_modules/.bin",
    ].join(":"),
    argv: ["/bun", "/stage/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs"],
    executable: "/bun",
    nodes: [{ file: "/tmp/bun-node-0-191755ec1/node", target: "/bun" }],
    symlink: false,
    content:
      "#!/bin/sh\n# OpenClaw Bun launcher\n#openclaw-bun=/bun\n#openclaw-entry=/stage/node_modules/openclaw/openclaw.mjs\n",
  };
  assertLifecycle([receipt], "/installed/openclaw", version);
  assertLifecycle([{ ...receipt, localPrefix: null }], "/installed/openclaw", version);
  assertLifecycle(
    [{ ...receipt, path: receipt.path.replace("-3C.node-gyp", "-375.node-gyp") }],
    "/installed/openclaw",
    version,
  );
  for (const override of [
    { event: "preinstall" },
    { phase: "enter" },
    { code: 1 },
    { cwd: "/installed/openclaw" },
    { nodes: [] },
    { localPrefix: "/unrelated-project" },
    { nodes: [{ file: "/inherited/bun-node-unrelated/node", target: "/bun" }] },
    { nodes: [{ file: "/tmp/bun-node-0-191755ec1/node", target: "/other-bun" }] },
    { path: receipt.path.replace("-3C.node-gyp", "-ZZ.node-gyp") },
    { path: receipt.path.replace(":/stage/node_modules/node_modules/.bin", "") },
    { path: receipt.path + ":/unexpected" },
    { path: "/usr/bin" },
    { symlink: true },
    { content: "#!/bin/sh\n" },
    { content: receipt.content.replace("#openclaw-bun=/bun", "#openclaw-bun=/other-bun") },
    { content: receipt.content.replace("openclaw/openclaw.mjs", "elsewhere/openclaw.mjs") },
    { argv: ["/doctor.mjs"] },
    { argv: ["/other-package/scripts/postinstall-bundled-plugins.mjs"] },
    { packageVersion: "old" },
  ]) {
    assert.throws(() =>
      assertLifecycle([{ ...receipt, ...override }], "/installed/openclaw", version),
    );
  }
  // Combining unrelated receipts must not fake the needed single postinstall event.
  assert.throws(() =>
    assertLifecycle(
      [
        { ...receipt, nodes: [] },
        { ...receipt, content: null },
      ],
      "/installed/openclaw",
      version,
    ),
  );
});
test("serialized observer and plugin fixture are valid independent modules", () => {
  const parent = path.resolve(".openclaw/tmp");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "upgrade-proof-syntax-"));
  try {
    const sources = {
      observer: lifecycleObserverSource(path.join(dir, 'ledger "quoted".jsonl')),
      plugin: pluginSource({
        plugin: path.join(dir, "plugin"),
        source: path.join(dir, "asset"),
        state: path.join(dir, "state"),
        ledger: path.join(dir, "events"),
      }),
    };
    for (const [name, source] of Object.entries(sources)) {
      assert(!source.includes("__LEDGER__"));
      const file = path.join(dir, name + ".mjs");
      fs.writeFileSync(file, source);
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
