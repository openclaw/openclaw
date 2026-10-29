import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, test } from "vitest";

// Local regression for the standalone release-line security adaptation.
const toolRoot = resolve(".github/release/clawhub-cli");
const script = resolve("scripts/materialize-clawhub-cli.sh");
const lockBytes = readFileSync(join(toolRoot, "package-lock.json"));
const lock = JSON.parse(lockBytes.toString("utf8"));
const manifest = JSON.parse(readFileSync(join(toolRoot, "package.json"), "utf8"));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("ClawHub override, Undici metadata, and materializer hash agree", () => {
  assert.equal(manifest.dependencies.clawhub, "0.23.3");
  assert.equal(manifest.overrides["clawhub@0.23.3"].undici, "7.30.1");
  assert.equal(lock.packages["node_modules/undici"].version, "7.30.1");
  assert.equal(
    lock.packages["node_modules/undici"].resolved,
    "https://registry.npmjs.org/undici/-/undici-7.30.1.tgz",
  );
  assert.equal(
    lock.packages["node_modules/undici"].integrity,
    "sha512-03KrMbjIFDWQR5RNPrSw3bd1r12JpyFQl9/yxjUbJtqkjmllqC5lFjZh6ujeuJCKr8EOQvRW872Oy/az+nLYxg==",
  );
  assert.ok(
    readFileSync(script, "utf8").includes('expected_lock_sha256="' + hash(lockBytes) + '"'),
  );
});

const fixtureRoots = new Set<string>();

afterEach(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clawhub-security-pin-"));
  fixtureRoots.add(root);
  const trusted = join(root, "trusted");
  const bin = join(root, "bin");
  const destination = join(root, "install");
  const output = join(root, "output");
  mkdirSync(trusted);
  mkdirSync(bin);
  copyFileSync(join(toolRoot, "package.json"), join(trusted, "package.json"));
  writeFileSync(join(trusted, "package-lock.json"), lockBytes);
  const npm = join(bin, "npm");
  const nl = String.fromCharCode(10);
  writeFileSync(
    npm,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$@" > "$PROOF_ROOT/npm-args"',
      'test "$PWD" = "$PROOF_ROOT/install"',
      "mkdir -p node_modules/clawhub node_modules/.bin",
      `echo '{"version":"0.23.3"}' > node_modules/clawhub/package.json`,
      'printf "#!/bin/sh\\nexit 0\\n" > node_modules/.bin/clawhub',
      "chmod +x node_modules/.bin/clawhub",
      "",
    ].join(nl),
  );
  chmodSync(npm, 0o755);
  const run = () =>
    spawnSync("bash", [script, trusted, destination, output], {
      encoding: "utf8",
      env: { PATH: bin + delimiter + process.env.PATH, HOME: root, PROOF_ROOT: root },
    });
  return { root, trusted, destination, output, run };
}

test("standalone materializer installs with lifecycle scripts disabled", () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readFileSync(join(f.root, "npm-args"), "utf8").trim().split(String.fromCharCode(10)),
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"],
  );
  assert.equal(
    readFileSync(f.output, "utf8"),
    [
      "cli=" + f.destination + "/node_modules/.bin/clawhub",
      "integrity=" + lock.packages["node_modules/clawhub"].integrity,
      "lock_sha256=" + hash(lockBytes),
      "version=0.23.3",
      "",
    ].join(String.fromCharCode(10)),
  );
});

test("changed lock fails before npm or CLI output", () => {
  const f = fixture();
  writeFileSync(join(f.trusted, "package-lock.json"), Buffer.concat([lockBytes, Buffer.from(" ")]));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lock SHA-256 mismatch/);
  assert.equal(existsSync(join(f.root, "npm-args")), false);
  assert.equal(existsSync(f.output), false);
});
