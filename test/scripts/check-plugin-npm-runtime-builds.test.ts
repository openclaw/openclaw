import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkPluginNpmRuntimeBuilds } from "../../scripts/check-plugin-npm-runtime-builds.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const built = (pluginDir: string, entryCount: number) => [
  { pluginDir, status: "built", entryCount, copiedStaticAssets: [] },
];

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

it.each([
  ["clawhub-only", { publishToClawHub: true }],
  ["npm-javascript-only", { publishToNpm: true }],
] as const)("rejects %s without a package-local runtime build plan", async (id, release) => {
  const { repoRoot, check } = fixture();
  writePackage(repoRoot, id, release, ["./index.js"]);
  await expect(check(id)).rejects.toThrow(
    `extensions/${id} did not produce a package-local runtime build plan`,
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

it.each([
  ["clawhub-typescript", { publishToClawHub: true }, false, 1],
  ["provider-plugin", { publishToNpm: true }, true, 2],
] as const)(
  "builds the %s runtime and its public artifacts",
  async (id, release, policy, count) => {
    const { repoRoot, check } = fixture();
    const packageDir = writePackage(repoRoot, id, release, ["./index.ts"]);
    writeFileSync(join(packageDir, "index.ts"), "export default {};\n");
    if (policy) {
      writeFileSync(
        join(packageDir, "provider-policy-api.ts"),
        "export function resolveThinkingProfile() { return { levels: [] }; }\n",
      );
    }
    await expect(check(id)).resolves.toEqual(built(id, count));
    if (policy) {
      expect(await import(join(packageDir, "dist", "provider-policy-api.js"))).toHaveProperty(
        "resolveThinkingProfile",
      );
    }
  },
);
