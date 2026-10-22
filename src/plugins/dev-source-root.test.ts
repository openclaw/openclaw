import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

it.each([
  ["same-commit development image", commit, "bundled"],
  ["release image", undefined, "official"],
  ["mismatched staged commit", "b".repeat(40), "official"],
])("selects the expected install source for a %s", (_name, stagedCommit, expected) => {
  const pluginRoot = fixture(stagedCommit);
  withPluginCache(createPluginCache(), () => {
    const request = resolveManagedPluginInstallRequest(
      { source: "official", pluginId: "codex" },
      [],
      "https://clawhub.ai",
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
          "https://clawhub.ai",
        ).source,
      ).toBe("official");
    }
  });
});

it.each([
  ["explicit version", commit, "@openclaw/codex@2026.9.3", false, "clawhub"],
  ["pinned package", commit, "@openclaw/codex", true, "clawhub"],
  ["unqualified package", commit, "@openclaw/codex", false, "clawhub"],
  ["explicit npm override", commit, "npm:@openclaw/codex", false, "npm"],
  ["release package", undefined, "@openclaw/codex@2026.9.3", false, "clawhub"],
  ["bare plugin ID", commit, "codex", false, "bundled"],
] as const)("preserves source selection for %s", (_name, stagedCommit, raw, pin, expected) => {
  fixture(stagedCommit);
  withPluginCache(createPluginCache(), () => {
    const plan = resolvePluginInstallSourcePlan({ raw, mode: "install", pin });
    expect(plan).toMatchObject({ ok: true, request: { source: expected } });
  });
});

it("does not grant source priority to unstaged or external plugin paths", () => {
  fixture(commit);
  const unstaged = path.join(host.root, "dist", "extensions", "other");
  fs.mkdirSync(unstaged);
  const external = tempDirs.make("external-codex-");
  withPluginCache(createPluginCache(), () => {
    expect(isBundledPluginInsideDevSourceRoot({ rootDir: unstaged, env: process.env })).toBe(false);
    expect(isBundledPluginInsideDevSourceRoot({ rootDir: external, env: process.env })).toBe(false);
  });
});
