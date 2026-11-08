// Runner guard/fixture syntax tests only; these do NOT constitute real upgrade evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertIdentity,
  assertLifecycle,
  assertStable,
  assertUpdate,
  lifecycleObserverSource,
  pluginSource,
  verifyPair,
} from "../../scripts/release-closeout-upgrade-proof.mjs";

const head = "a".repeat(40),
  sha = "b".repeat(64),
  version = "2026.11.2";
function proof(lane) {
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
  ]) {
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
    cwd: "/stage/openclaw",
    localPrefix: null,
    path: [
      "/stage/openclaw/node_modules/.bin",
      "/usr/bin",
      "/tmp/.ade21d781aa39b9e-375.node-gyp",
      "/tmp/bun-node-0-191755ec1",
      "/stage/node_modules/.bin",
      "/node_modules/.bin",
    ].join(":"),
    argv: ["/bun", "/stage/openclaw/scripts/postinstall-bundled-plugins.mjs"],
    executable: "/bun",
    nodes: [{ file: "/tmp/bun-node-test/node", target: "/bun" }],
    symlink: false,
    content: "#!/bin/sh\n# OpenClaw Bun launcher\n",
  };
  assertLifecycle([receipt], "/installed/openclaw", version);
  for (const override of [
    { event: "preinstall" },
    { phase: "enter" },
    { code: 1 },
    { cwd: "/installed/openclaw" },
    { nodes: [] },
    { localPrefix: "/stage" },
    { path: "/usr/bin" },
    { symlink: true },
    { content: "#!/bin/sh\n" },
    { argv: ["/doctor.mjs"] },
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
