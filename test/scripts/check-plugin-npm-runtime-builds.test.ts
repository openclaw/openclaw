import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPluginNpmRuntimeBuilds } from "../../scripts/check-plugin-npm-runtime-builds.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const built = (pluginDir: string, entryCount: number) => [
  { pluginDir, status: "built", entryCount, copiedStaticAssets: [] },
];

describe("plugin npm runtime build checks", () => {
  function writePackage(
    repoRoot: string,
    pluginId: string,
    release: { publishToClawHub?: boolean; publishToNpm?: boolean },
    extensions?: string[],
  ) {
    const packageDir = join(repoRoot, "extensions", pluginId);
    writeJsonFile(join(packageDir, "package.json"), {
      name: `@openclaw/${pluginId}`,
      version: "2026.6.2",
      type: "module",
      openclaw: {
        compat: { pluginApi: ">=2026.4.30" },
        extensions,
        release,
      },
    });
    return packageDir;
  }

  function fixture() {
    const repoRoot = tempDirs.make("openclaw-plugin-runtime-check-");
    return {
      repoRoot,
      check: (id: string) =>
        checkPluginNpmRuntimeBuilds({ repoRoot, packageDirs: [`extensions/${id}`] }),
    };
  }

  it("rejects publishable packages without a package-local runtime build plan", async () => {
    const { repoRoot, check } = fixture();
    writePackage(repoRoot, "clawhub-only", { publishToClawHub: true }, ["./index.js"]);
    writePackage(repoRoot, "npm-javascript-only", { publishToNpm: true }, ["./index.js"]);

    await expect(check("clawhub-only")).rejects.toThrow(
      "extensions/clawhub-only did not produce a package-local runtime build plan",
    );
    await expect(check("npm-javascript-only")).rejects.toThrow(
      "extensions/npm-javascript-only did not produce a package-local runtime build plan",
    );
  });

  it("rejects invalid explicit package targets", async () => {
    const { repoRoot, check } = fixture();
    writePackage(repoRoot, "not-publishable", {});

    await expect(check("not-publishable")).rejects.toThrow(
      "did not produce a package-local runtime build plan",
    );
    await expect(check("missing")).rejects.toMatchObject({
      code: "ENOENT",
      path: join(repoRoot, "extensions", "missing", "package.json"),
    });
  });

  it("builds a ClawHub-only TypeScript package runtime", async () => {
    const { repoRoot, check } = fixture();
    const dir = writePackage(repoRoot, "clawhub-typescript", { publishToClawHub: true }, [
      "./index.ts",
    ]);
    writeFileSync(join(dir, "index.ts"), "export default {};\n");

    await expect(check("clawhub-typescript")).resolves.toEqual(built("clawhub-typescript", 1));
  });

  it("builds top-level public policy surfaces as standalone package artifacts", async () => {
    const { repoRoot, check } = fixture();
    const packageDir = writePackage(repoRoot, "provider-plugin", { publishToNpm: true }, [
      "./index.ts",
    ]);
    writeFileSync(join(packageDir, "index.ts"), "export default {};\n");
    writeFileSync(
      join(packageDir, "provider-policy-api.ts"),
      "export function resolveThinkingProfile() { return { levels: [] }; }\n",
    );

    await expect(check("provider-plugin")).resolves.toEqual(built("provider-plugin", 2));
    expect(await import(join(packageDir, "dist", "provider-policy-api.js"))).toHaveProperty(
      "resolveThinkingProfile",
    );
  });
});
