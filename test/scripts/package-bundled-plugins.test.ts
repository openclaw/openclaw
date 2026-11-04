import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePackageBundledPlugins } from "../../scripts/lib/package-bundled-plugins.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture() {
  const root = tempDirs.make("openclaw-selected-plugin-");
  const source = path.join(root, "extensions", "kimi-coding");
  const built = path.join(root, "dist", "extensions", "kimi-coding");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(built, { recursive: true });
  const rootPackage = {
    name: "openclaw",
    version: "1.0.0",
    files: ["dist/**", "!dist/extensions/kimi-coding/**", "!dist/extensions/unselected/**"],
  };
  const pluginPackage = {
    name: "@openclaw/kimi",
    version: "1.0.0",
    dependencies: { "fixture-required": "1.0.0" },
    optionalDependencies: { "fixture-optional": "1.0.0" },
    peerDependencies: { openclaw: "^1.0.0" },
    peerDependenciesMeta: { openclaw: { optional: true } },
    openclaw: { extensions: ["./index.ts"], build: { bundledDist: false } },
  };
  const builtPackage = {
    ...pluginPackage,
    openclaw: { ...pluginPackage.openclaw, extensions: ["./index.js"] },
  };
  const writeJson = (directory: string, name: string, value: unknown) =>
    fs.writeFile(path.join(directory, name), JSON.stringify(value));
  await writeJson(root, "package.json", rootPackage);
  await writeJson(source, "package.json", pluginPackage);
  await writeJson(built, "package.json", builtPackage);
  await writeJson(source, "openclaw.plugin.json", { id: "kimi" });
  await writeJson(built, "openclaw.plugin.json", { id: "kimi" });
  await fs.writeFile(path.join(source, "index.ts"), "export default {};\n");
  await fs.writeFile(path.join(built, "index.js"), "export default {};\n");
  const cleanupFailure = vi.fn();
  const prepare = () => preparePackageBundledPlugins(root, ["kimi-coding"], cleanupFailure);
  const reject = async () => {
    await expect(prepare()).rejects.toThrow(
      "Built plugin kimi-coding does not match source metadata; rebuild before packaging",
    );
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toEqual(
      rootPackage,
    );
    expect(cleanupFailure).not.toHaveBeenCalled();
  };
  return { root, source, built, rootPackage, builtPackage, writeJson, prepare, reject };
}

describe("selected bundled plugin source identity", () => {
  it("packages the approved directory/manifest exception without including other plugins", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    try {
      const composed = JSON.parse(await fs.readFile(path.join(f.root, "package.json"), "utf8"));
      expect(composed.files).toEqual(["dist/**", "!dist/extensions/unselected/**"]);
      expect(
        JSON.parse(await fs.readFile(path.join(f.built, "package.json"), "utf8")),
      ).toMatchObject({ openclaw: { build: { bundledDist: true } } });
      expect(
        JSON.parse(await fs.readFile(path.join(f.built, "openclaw.plugin.json"), "utf8")),
      ).toEqual({ id: "kimi" });
    } finally {
      await prepared.cleanup();
    }
    expect(JSON.parse(await fs.readFile(path.join(f.root, "package.json"), "utf8"))).toEqual(
      f.rootPackage,
    );
    expect(JSON.parse(await fs.readFile(path.join(f.built, "package.json"), "utf8"))).toEqual(
      f.builtPackage,
    );
  });

  it.each(["kimi-coding", "stale-kimi"])("rejects a stale built manifest id %s", async (id) => {
    const f = await fixture();
    await f.writeJson(f.built, "openclaw.plugin.json", { id });
    await f.reject();
  });

  it.each(["", undefined])(
    "rejects an invalid source id even when built agrees: %s",
    async (id) => {
      const f = await fixture();
      await f.writeJson(f.source, "openclaw.plugin.json", { id });
      await f.writeJson(f.built, "openclaw.plugin.json", { id });
      await f.reject();
    },
  );

  it.each([
    "name",
    "version",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
  ] as const)("still rejects changed built package metadata: %s", async (key) => {
    const f = await fixture();
    await f.writeJson(f.built, "package.json", {
      ...f.builtPackage,
      [key]: key === "name" || key === "version" ? "stale" : {},
    });
    await f.reject();
  });
});
