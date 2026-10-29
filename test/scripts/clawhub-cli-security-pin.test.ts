import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("ClawHub manifest, lock and materializer pin patched Undici", () => {
  const root = new URL("../../", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), "utf8");
  const manifest = JSON.parse(read(".github/release/clawhub-cli/package.json"));
  const lockBytes = read(".github/release/clawhub-cli/package-lock.json");
  const lock = JSON.parse(lockBytes);
  const materializer = read("scripts/materialize-clawhub-cli.sh");
  const undici = lock.packages["node_modules/undici"];

  assert.equal(manifest.dependencies.clawhub, "0.23.3");
  assert.equal(manifest.overrides["clawhub@0.23.3"].undici, "7.30.1");
  assert.equal(lock.packages["node_modules/clawhub"].version, "0.23.3");
  assert.equal(undici.version, "7.30.1");
  assert.equal(undici.resolved, "https://registry.npmjs.org/undici/-/undici-7.30.1.tgz");
  assert.equal(
    undici.integrity,
    "sha512-03KrMbjIFDWQR5RNPrSw3bd1r12JpyFQl9/yxjUbJtqkjmllqC5lFjZh6ujeuJCKr8EOQvRW872Oy/az+nLYxg==",
  );
  const lockHash = createHash("sha256").update(lockBytes).digest("hex");
  assert.ok(materializer.includes(`expected_lock_sha256="${lockHash}"`));
  assert.ok(materializer.includes("--ignore-scripts"));
  assert.ok(materializer.includes("--omit=dev"));
});
