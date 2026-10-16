import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isBundledPluginInsideDevSourceRoot } from "./dev-source-root.js";
import {
  resolveManagedPluginInstallRequest,
  resolvePluginInstallSourcePlan,
} from "./install-source-plan.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";

const host = vi.hoisted(() => ({ root: "" }));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRootSync: () => host.root,
}));

const commit = "a".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function fixture(stagedCommit?: string) {
  host.root = tempDirs.make("staged-official-plugins-");
  const pluginRoot = path.join(host.root, "dist", "extensions", "codex");
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const [file, value] of [
    ["package.json", { name: "openclaw", version: "2026.10.2" }],
    [
      "dist/build-info.json",
      {
        commit,
        ...(stagedCommit
          ? { stagedOfficialPlugins: { commit: stagedCommit, pluginIds: ["codex"] } }
          : {}),
      },
    ],
    [
      "dist/extensions/codex/package.json",
      {
        name: "@openclaw/codex",
        version: "2026.10.2",
        openclaw: { extensions: ["./index.js"] },
      },
    ],
    ["dist/extensions/codex/openclaw.plugin.json", { id: "codex", configSchema: {} }],
  ] as const) {
    fs.writeFileSync(path.join(host.root, file), JSON.stringify(value));
  }
  fs.writeFileSync(path.join(pluginRoot, "index.js"), "export default {};\n");
  vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", undefined);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.dirname(pluginRoot));
  return pluginRoot;
}

describe("packaged development official plugins", () => {
  it.each([
    { name: "same-commit development image", stagedCommit: commit, expected: "bundled" },
    { name: "release image", stagedCommit: undefined, expected: "official" },
    { name: "mismatched staged commit", stagedCommit: "b".repeat(40), expected: "official" },
  ])("selects the expected install source for a $name", ({ stagedCommit, expected }) => {
    const pluginRoot = fixture(stagedCommit);
    withPluginCache(createPluginCache(), () => {
      const request = resolveManagedPluginInstallRequest(
        { source: "official", pluginId: "codex" },
        [],
      );
      expect(request.source).toBe(expected);
      expect(isBundledPluginInsideDevSourceRoot({ rootDir: pluginRoot, env: process.env })).toBe(
        expected === "bundled",
      );
      if (request.source === "bundled") {
        expect(request.bundledSource.localPath).toBe(pluginRoot);
        expect(request.rawSpec).toBe("@openclaw/codex");
      }
    });
  });

  it("preserves explicit version and pin requests", () => {
    fixture(commit);
    withPluginCache(createPluginCache(), () => {
      for (const choice of [{ version: "latest" as const }, { pin: true }]) {
        expect(
          resolveManagedPluginInstallRequest(
            { source: "official", pluginId: "codex", ...choice },
            [],
          ).source,
        ).toBe("official");
      }
    });
  });

  it.each([
    {
      name: "explicit version",
      stagedCommit: commit,
      raw: "@openclaw/codex@2026.9.3",
      pin: false,
      expected: "npm",
    },
    {
      name: "pinned package",
      stagedCommit: commit,
      raw: "@openclaw/codex",
      pin: true,
      expected: "official",
    },
    {
      name: "unqualified package",
      stagedCommit: commit,
      raw: "@openclaw/codex",
      pin: false,
      expected: "bundled",
    },
    {
      name: "explicit npm override",
      stagedCommit: commit,
      raw: "npm:@openclaw/codex",
      pin: false,
      expected: "npm",
    },
    {
      name: "release package",
      stagedCommit: undefined,
      raw: "@openclaw/codex@2026.9.3",
      pin: false,
      expected: "bundled",
    },
  ])("preserves source selection for $name", ({ stagedCommit, raw, pin, expected }) => {
    fixture(stagedCommit);
    withPluginCache(createPluginCache(), () => {
      const plan = resolvePluginInstallSourcePlan({
        raw,
        mode: "install",
        pin,
      });
      expect(plan).toMatchObject({ ok: true, request: { source: expected } });
    });
  });

  it("does not grant source priority to unstaged or external plugin paths", () => {
    const pluginRoot = fixture(commit);
    const unstaged = path.join(host.root, "dist", "extensions", "other");
    fs.mkdirSync(unstaged);
    const external = tempDirs.make("external-codex-");
    withPluginCache(createPluginCache(), () => {
      expect(isBundledPluginInsideDevSourceRoot({ rootDir: pluginRoot, env: process.env })).toBe(
        true,
      );
      expect(isBundledPluginInsideDevSourceRoot({ rootDir: unstaged, env: process.env })).toBe(
        false,
      );
      expect(isBundledPluginInsideDevSourceRoot({ rootDir: external, env: process.env })).toBe(
        false,
      );
    });
  });
});
