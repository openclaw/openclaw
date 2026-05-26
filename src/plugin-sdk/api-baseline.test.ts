import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizePluginSdkApiDeclarationText,
  normalizePluginSdkApiSourcePath,
} from "./api-baseline.js";

describe("Plugin SDK API baseline", () => {
  it("normalizes declaration import paths to repo-relative paths", () => {
    const repoRoot = process.cwd();
    const modelCatalogPath = path.join(repoRoot, "src", "agents", "pi-model-discovery-runtime");
    const declaration = `export function setModelCatalogImportForTest(loader?: (() => Promise<typeof import("${modelCatalogPath}", { with: { "resolution-mode": "import" } })>) | undefined): void;`;

    const normalized = normalizePluginSdkApiDeclarationText(repoRoot, declaration);

    expect(normalized).not.toContain(repoRoot);
    expect(normalized).toContain(
      'import("src/agents/pi-model-discovery-runtime", { with: { "resolution-mode": "import" } })',
    );
  });

  it("normalizes physical package install paths to stable node_modules paths", () => {
    const repoRoot = process.cwd();

    expect(
      normalizePluginSdkApiSourcePath(
        repoRoot,
        "/tmp/openclaw-pnpm-node-modules/@openclaw/fs-safe/dist/secret-file.d.ts",
      ),
    ).toBe("node_modules/@openclaw/fs-safe/dist/secret-file.d.ts");
    expect(
      normalizePluginSdkApiDeclarationText(
        repoRoot,
        'export type SecretFile = import("/tmp/openclaw-pnpm-node-modules/@openclaw/fs-safe/dist/secret-file").SecretFile;',
      ),
    ).toContain('import("node_modules/@openclaw/fs-safe/dist/secret-file").SecretFile');
  });
});
