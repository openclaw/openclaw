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
import { writeArtifacts as writeTree } from "./public-surface.test-support.js";

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
  const identity = { name: "openclaw", version: "2026.10.2" };
  writeTree(host.root, {
    "package.json": identity,
    "dist/build-info.json": {
      commit,
      ...(stagedCommit
        ? { stagedOfficialPlugins: { commit: stagedCommit, pluginIds: ["codex"] } }
        : {}),
    },
    "dist/extensions/codex/package.json": {
      ...identity,
      name: "@openclaw/codex",
      openclaw: { extensions: ["./index.js"] },
    },
    "dist/extensions/codex/openclaw.plugin.json": { id: "codex", configSchema: {} },
    "dist/extensions/codex/index.js": "export default {};\n",
  });
  vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", undefined);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.dirname(pluginRoot));
  return pluginRoot;
}

it.each([
  [commit, undefined, false, "bundled"],
  [undefined, undefined, false, "official"],
  ["b".repeat(40), undefined, false, "official"],
  [commit, "latest", false, "official"],
  [commit, undefined, true, "official"],
] as const)(
  "selects official source with staged=%s version=%s pin=%s",
  (stagedCommit, version, pin, expected) => {
    const pluginRoot = fixture(stagedCommit);
    withPluginCache(createPluginCache(), () => {
      const request = resolveManagedPluginInstallRequest(
        { source: "official", pluginId: "codex", version, pin },
        [],
        "https://clawhub.ai",
      );
      expect(request.source).toBe(expected);
      if (request.source === "bundled") {
        expect(request.bundledSource.localPath).toBe(pluginRoot);
        expect(request.rawSpec).toBe("@openclaw/codex");
      }
    });
  },
);

it.each([
  ["@openclaw/codex@2026.9.3", "clawhub"],
  ["@openclaw/codex", "clawhub"],
  ["npm:@openclaw/codex", "npm"],
  ["codex", "bundled"],
] as const)("selects the source for %s", (raw, expected) => {
  fixture(commit);
  withPluginCache(createPluginCache(), () => {
    const plan = resolvePluginInstallSourcePlan({ raw, mode: "install" });
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
