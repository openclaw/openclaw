import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const nodeModules = path.join(projectRoot, "node_modules");

// Use dynamic import for the CJS patch script (createRequire fails in vmForks
// because the shebang line is not valid JS in the VM context).
const { patchDir } = (await import(
  /* @vite-ignore */ path.join(projectRoot, "scripts/patch-esm-exports.cjs")
)) as {
  patchDir: (dir: string) => {
    patchedCount: number;
    errors: Array<{ file: string; error: string }>;
  };
};

const projectRequire = createRequire(path.join(projectRoot, "__anchor__.js"));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "esm-patch-e2e-"));

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

let caseIndex = 0;

/**
 * Create a fake ESM-only package inside a fresh temp directory.
 * Uses a unique package name per call to avoid Node.js module-resolution caching.
 */
function createEsmOnlyPackage(prefix = "esm-only") {
  const id = caseIndex++;
  const pkgName = `${prefix}-e2e-${id}-${Date.now()}`;
  const root = path.join(fixtureRoot, `case-${id}`);
  const pkgDir = path.join(root, "node_modules", pkgName);
  const distDir = path.join(pkgDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.mjs"), "export default {};");

  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: pkgName, exports: { ".": { import: "./dist/index.mjs" } } }, null, 2) +
      "\n",
    "utf8",
  );

  return { root, pkgDir, pkgName };
}

// ERR_PACKAGE_PATH_NOT_EXPORTED is the error code; the message text varies by Node version.
const ESM_EXPORT_ERROR = /ERR_PACKAGE_PATH_NOT_EXPORTED|No "exports" main defined/;

describe("patch-esm-exports e2e", () => {
  describe("reproduces ERR_PACKAGE_PATH_NOT_EXPORTED without patch", () => {
    it("CJS require.resolve fails for ESM-only package", () => {
      const { root, pkgName } = createEsmOnlyPackage();
      const req = createRequire(path.join(root, "__test__.js"));

      expect(() => req.resolve(pkgName)).toThrowError(ESM_EXPORT_ERROR);
    });

    it("CJS require() fails for ESM-only package", () => {
      const { root, pkgName } = createEsmOnlyPackage();
      const req = createRequire(path.join(root, "__test__.js"));

      expect(() => req(pkgName)).toThrowError(ESM_EXPORT_ERROR);
    });
  });

  describe("patch fixes CJS resolution", () => {
    it("require.resolve succeeds after patchDir", () => {
      // Use unique package name and patch BEFORE first resolution attempt
      // to avoid Node.js caching the export-map failure.
      const { root, pkgName } = createEsmOnlyPackage("fix-resolve");
      const result = patchDir(root);
      expect(result.patchedCount).toBe(1);
      expect(result.errors).toHaveLength(0);

      const req = createRequire(path.join(root, "__test__.js"));
      const resolved = req.resolve(pkgName);
      expect(resolved).toContain(path.join("dist", "index.mjs"));
    });

    it("patched package.json has correct 'default' condition", () => {
      const { root, pkgDir } = createEsmOnlyPackage("fix-pkg");
      patchDir(root);

      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
        exports: Record<string, Record<string, string>>;
      };
      expect(pkg.exports["."]).toHaveProperty("default", "./dist/index.mjs");
      expect(pkg.exports["."]).toHaveProperty("import", "./dist/index.mjs");
    });

    it("handles packages with multiple export entries", () => {
      const id = caseIndex++;
      const pkgName = `esm-multi-e2e-${id}-${Date.now()}`;
      const root = path.join(fixtureRoot, `case-${id}`);
      const pkgDir = path.join(root, "node_modules", pkgName);
      const distDir = path.join(pkgDir, "dist");
      fs.mkdirSync(path.join(distDir, "hooks"), { recursive: true });
      fs.writeFileSync(path.join(distDir, "index.mjs"), "export default {};");
      fs.writeFileSync(path.join(distDir, "hooks", "index.mjs"), "export default {};");
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: pkgName,
          exports: {
            ".": { import: "./dist/index.mjs" },
            "./hooks": { import: "./dist/hooks/index.mjs" },
          },
        }) + "\n",
        "utf8",
      );

      // Patch before first resolution to avoid caching the failure
      const result = patchDir(root);
      expect(result.patchedCount).toBe(1);

      const req = createRequire(path.join(root, "__test__.js"));
      const resolved = req.resolve(pkgName);
      expect(resolved).toContain(path.join("dist", "index.mjs"));

      const resolvedHooks = req.resolve(`${pkgName}/hooks`);
      expect(resolvedHooks).toContain(path.join("dist", "hooks", "index.mjs"));
    });
  });

  describe("real-world package verification", () => {
    it("@buape/carbon is resolvable via CJS require.resolve", () => {
      const resolved = projectRequire.resolve("@buape/carbon");
      expect(resolved).toBeTruthy();
      expect(fs.existsSync(resolved)).toBe(true);
    });

    it("osc-progress is resolvable via CJS require.resolve", () => {
      const resolved = projectRequire.resolve("osc-progress");
      expect(resolved).toBeTruthy();
      expect(fs.existsSync(resolved)).toBe(true);
    });

    it("@mariozechner/pi-coding-agent is resolvable via CJS require.resolve", () => {
      const resolved = projectRequire.resolve("@mariozechner/pi-coding-agent");
      expect(resolved).toBeTruthy();
      expect(fs.existsSync(resolved)).toBe(true);
    });

    it("real packages have 'default' condition in exports after postinstall", () => {
      const packages = ["@buape/carbon", "osc-progress", "@mariozechner/pi-coding-agent"];
      for (const pkg of packages) {
        const pkgJsonPath = path.join(nodeModules, ...pkg.split("/"), "package.json");
        const manifest = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
          exports?: Record<string, Record<string, string>>;
        };
        expect(manifest.exports, `${pkg} should have exports`).toBeDefined();
        const mainEntry = manifest.exports!["."];
        expect(mainEntry, `${pkg} should have '.' export`).toBeDefined();
        expect(mainEntry).toHaveProperty("default");
        expect(mainEntry).toHaveProperty("import");
        expect(mainEntry.default).toBe(mainEntry.import);
      }
    });

    it("jiti can resolve a patched package", async () => {
      const { createJiti } = await import("jiti");

      // Anchor jiti at the project root so node_modules resolution works.
      const jiti = createJiti(path.join(projectRoot, "__entry__.ts"), {
        interopDefault: true,
      });

      // Verify jiti's internal resolution finds the patched package.
      // We use resolve() rather than evaluation to avoid vmForks VM context
      // conflicts with jiti's module wrapper.
      const resolved = jiti.resolve("@buape/carbon");
      expect(resolved).toBeTruthy();
      expect(fs.existsSync(resolved)).toBe(true);
    });
  });
});
