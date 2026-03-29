import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyMatrixCryptoWasmPkg } from "../../scripts/copy-matrix-crypto-wasm-pkg.mjs";

function createRepoFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-wasm-pkg-"));
}

describe("copyMatrixCryptoWasmPkg", () => {
  it("stages the matrix crypto wasm package into dist/pkg", () => {
    const repoRoot = createRepoFixture();
    const sourcePkgDir = path.join(
      repoRoot,
      "node_modules",
      "@matrix-org",
      "matrix-sdk-crypto-wasm",
      "pkg",
    );
    fs.mkdirSync(sourcePkgDir, { recursive: true });
    fs.writeFileSync(path.join(sourcePkgDir, "matrix_sdk_crypto_wasm_bg.wasm"), "wasm\n", "utf8");
    fs.writeFileSync(path.join(sourcePkgDir, "matrix_sdk_crypto_wasm_bg.js"), "js\n", "utf8");

    copyMatrixCryptoWasmPkg({ cwd: repoRoot });

    expect(
      fs.readFileSync(path.join(repoRoot, "dist", "pkg", "matrix_sdk_crypto_wasm_bg.wasm"), "utf8"),
    ).toBe("wasm\n");
    expect(
      fs.readFileSync(path.join(repoRoot, "dist", "pkg", "matrix_sdk_crypto_wasm_bg.js"), "utf8"),
    ).toBe("js\n");
  });

  it("removes stale dist/pkg output when the source package is unavailable", () => {
    const repoRoot = createRepoFixture();
    const staleTargetDir = path.join(repoRoot, "dist", "pkg");
    fs.mkdirSync(staleTargetDir, { recursive: true });
    fs.writeFileSync(path.join(staleTargetDir, "stale.txt"), "stale\n", "utf8");

    copyMatrixCryptoWasmPkg({ cwd: repoRoot });

    expect(fs.existsSync(staleTargetDir)).toBe(false);
  });
});
