// Local release-line adaptation: guard the dedicated graph without repo dependencies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const sourceRoot = join(root, ".github/release/clawhub-cli");
const lockBytes = readFileSync(join(sourceRoot, "package-lock.json"));
const lock = JSON.parse(lockBytes);
const manifest = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
const script = join(root, "scripts/materialize-clawhub-cli.sh");
const hash = createHash("sha256").update(lockBytes).digest("hex");

test("dedicated ClawHub manifest, lock, and materializer pin patched Undici", () => {
  assert.equal(manifest.overrides["clawhub@0.23.3"].undici, "7.30.1");
  assert.deepEqual(manifest.dependencies, { clawhub: "0.23.3" });
  assert.equal(lock.packages["node_modules/clawhub"].version, "0.23.3");
  assert.deepEqual(
    Object.entries(lock.packages).filter(
      ([path]) => path === "node_modules/undici" || path.endsWith("/node_modules/undici"),
    ),
    [
      [
        "node_modules/undici",
        {
          version: "7.30.1",
          resolved: "https://registry.npmjs.org/undici/-/undici-7.30.1.tgz",
          integrity:
            "sha512-03KrMbjIFDWQR5RNPrSw3bd1r12JpyFQl9/yxjUbJtqkjmllqC5lFjZh6ujeuJCKr8EOQvRW872Oy/az+nLYxg==",
          license: "MIT",
          engines: { node: ">=20.18.1" },
        },
      ],
    ],
  );
  assert.ok(readFileSync(script, "utf8").includes('expected_lock_sha256="' + hash + '"'));
});

for (const tampered of [false, true]) {
  test(
    "standalone materializer " +
      (tampered ? "rejects changed lock before npm" : "accepts pinned lock offline"),
    () => {
      const temp = mkdtempSync(join(tmpdir(), "clawhub-security-pin-"));
      try {
        const trusted = join(temp, "trusted");
        const bin = join(temp, "bin");
        const destination = join(temp, "install");
        const output = join(temp, "outputs");
        mkdirSync(trusted);
        mkdirSync(bin);
        copyFileSync(join(sourceRoot, "package.json"), join(trusted, "package.json"));
        writeFileSync(
          join(trusted, "package-lock.json"),
          tampered ? Buffer.concat([lockBytes, Buffer.from(" ")]) : lockBytes,
        );
        writeFileSync(
          join(bin, "npm"),
          [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            'printf \'%s\n\' "$@" > "$PROOF_ROOT/npm-args"',
            'test "$PWD" = "$PROOF_ROOT/install"',
            "mkdir -p node_modules/clawhub node_modules/.bin",
            "printf '%s' '{\"version\":\"0.23.3\"}' > node_modules/clawhub/package.json",
            "printf '#!/bin/sh\nexit 0\n' > node_modules/.bin/clawhub",
            "chmod +x node_modules/.bin/clawhub",
          ].join("\n"),
          { mode: 0o755 },
        );
        const result = spawnSync("bash", [script, trusted, destination, output], {
          encoding: "utf8",
          env: { PATH: bin + delimiter + process.env.PATH, HOME: temp, PROOF_ROOT: temp },
        });
        if (tampered) {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /lock SHA-256 mismatch/);
          assert.equal(existsSync(join(temp, "npm-args")), false);
          assert.equal(existsSync(output), false);
        } else {
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(readFileSync(join(temp, "npm-args"), "utf8").trim().split("\n"), [
            "ci",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--omit=dev",
          ]);
          assert.ok(readFileSync(output, "utf8").includes("lock_sha256=" + hash + "\n"));
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
}
