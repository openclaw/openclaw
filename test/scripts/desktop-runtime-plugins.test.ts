import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  desktopRuntimeReleaseTag,
  planDesktopRuntimePlugins,
  stampDesktopRuntimePlugins,
} from "../../scripts/lib/desktop-runtime-plugins.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const runtimeScript = path.resolve("scripts/lib/desktop-runtime-plugins.mjs");
beforeEach(() => {
  vi.stubEnv("RELEASE_TAG", undefined);
  vi.stubEnv("RELEASE_SHA", undefined);
});
afterEach(() => vi.unstubAllEnvs());
const writeJson = (root: string, file: string, value: unknown) => {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value));
};
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (root: string, ...args: string[]) => run("git", ["-C", root, ...args]);
const readJson = (root: string, file: string) =>
  JSON.parse(readFileSync(path.join(root, file), "utf8"));
function writePlugin(root: string, id: string) {
  writeJson(root, `dist/extensions/${id}/package.json`, {
    openclaw: { extensions: ["./index.mjs"] },
  });
  writeFileSync(path.join(root, `dist/extensions/${id}/index.mjs`), "export {};\n");
}
function fixture(dependencies?: Record<string, string>) {
  const root = temps.make("desktop-runtime-plugins-");
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "fixture");
  const commit = git(root, "rev-parse", "HEAD");
  writeJson(root, "package.json", {
    version: "2026.10.2",
    files: ["!dist/extensions/codex/**", "!dist/extensions/extra/**"],
    ...(dependencies ? { dependencies } : {}),
  });
  writeJson(root, "dist/build-info.json", { commit, buildId: "fixture" });
  writeJson(root, "scripts/lib/official-external-plugin-catalog.json", {
    entries: [{ name: "@openclaw/codex" }, { name: "@openclaw/extra" }],
  });
  for (const id of ["codex", "extra"]) {
    writeJson(root, `extensions/${id}/package.json`, { name: `@openclaw/${id}` });
    writePlugin(root, id);
  }
  return { root, commit };
}

function shallowRelease(tag = "v2026.10.2") {
  const { root: origin } = fixture();
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "release");
  const commit = git(origin, "rev-parse", "HEAD");
  git(origin, "tag", "-a", tag, "-m", "release");
  const root = temps.make("desktop-release-clone-");
  git(origin, "clone", "--quiet", "--depth=1", "--no-tags", pathToFileURL(origin).href, root);
  expect(git(root, "rev-parse", "--is-shallow-repository")).toBe("true");
  expect(git(root, "tag", "--list")).toBe("");
  rmSync(path.join(root, "dist"), { recursive: true });
  return { root, origin, commit };
}

it.each([
  ["v2026.10.2", true, false],
  ["v2026.10.2", false, false],
  ["v2026.10.2", false, true],
  ["v2026.10.2-1", true, false],
  ["v2026.10.2-1", true, true],
] as const)(
  "checks shallow %s identity (verified SHA: %s; wrong fetched commit: %s)",
  (tag, withSha, wrongCommit) => {
    const { root, origin, commit } = shallowRelease(tag);
    const correction = tag === "v2026.10.2-1";
    const fetchedTag = correction ? "v2026.10.2" : tag;
    const fetchedCommit = wrongCommit ? `${commit}^` : commit;
    if (correction || wrongCommit) {
      git(origin, "tag", "-f", fetchedTag, fetchedCommit);
    }
    vi.stubEnv("RELEASE_TAG", tag);
    if (withSha) {
      vi.stubEnv("RELEASE_SHA", commit);
    }
    const plan = () =>
      correction || wrongCommit
        ? planDesktopRuntimePlugins(root)
        : JSON.parse(run(process.execPath, [runtimeScript, "plan", root]));
    if (wrongCommit) {
      expect(plan).toThrow("does not match source commit");
    } else {
      expect(plan()).toEqual({ commit, releaseTag: tag, pluginIds: [] });
    }
  },
);

it.each([
  ["v2026.10.2", "0".repeat(40), [], "does not match source commit"],
  ["v2026.10.2", "", [], "does not match source commit"],
  ["v2026.10.3", undefined, [], "does not match release tag"],
  ["", undefined, [], "RELEASE_TAG"],
  [undefined, "0".repeat(40), [], "RELEASE_TAG"],
  [undefined, undefined, ["release/2026.10.2", "v2026.9.2"], null],
  [undefined, undefined, ["v2026.10.2-1"], "requires same-source base tag v2026.10.2"],
] as const)("validates release identity (%s, %s, %j)", (tag, sha, tags, error) => {
  const { root, commit } = fixture();
  for (const localTag of tags) {
    git(root, "tag", localTag);
  }
  vi.stubEnv("RELEASE_TAG", tag);
  vi.stubEnv("RELEASE_SHA", sha);
  const resolve = () => desktopRuntimeReleaseTag(root, "2026.10.2", commit);
  if (error) {
    expect(resolve).toThrow(error);
  } else {
    expect(resolve()).toBeNull();
  }
});

it.runIf(process.platform === "darwin")("normalizes only staged voice rpaths", async () => {
  const { auditMacRuntimePortability } =
    await import("../../scripts/lib/mac-runtime-portability.mjs");
  const root = temps.make("desktop-runtime-codex-native-");
  const commit = "a".repeat(40);
  writeJson(root, "dist/build-info.json", { commit });
  writePlugin(root, "codex");
  for (const name of ["codex", "codex-darwin-arm64"]) {
    writeJson(root, `node_modules/@openai/${name}/package.json`, {});
  }
  const voice = path.join(
    root,
    "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-resources/voice",
  );
  mkdirSync(path.join(voice, "lib"), { recursive: true });
  mkdirSync(path.join(voice, "bin"));
  const host = path.join(voice, "bin/codex-voice-host");
  const rpaths = [
    "@loader_path/../../_solib_darwin_arm64/voice/native_link_macos_aarch64",
    "@loader_path/../lib",
  ];
  const args = ["-x", "c", "-", "-o", host, ...rpaths.map((rpath) => `-Wl,-rpath,${rpath}`)];
  execFileSync("/usr/bin/clang", args, { input: "int main(void) { return 0; }\n" });
  const original = readFileSync(host);
  stampDesktopRuntimePlugins(root, { commit, pluginIds: [] });
  expect(readFileSync(host)).toEqual(original);
  expect(() => auditMacRuntimePortability(root, host)).toThrow("Nonportable LC_RPATH");
  stampDesktopRuntimePlugins(root, { commit, pluginIds: ["codex"] });
  expect(auditMacRuntimePortability(root, host)).toBe(1);
});

it.each(["2026.10.2-beta.1", "2026.10.2-alpha.1", "2026.10.33"])(
  "recognizes exact release version %s",
  (version) => {
    const { root, commit } = fixture();
    git(root, "tag", `v${version}`);
    expect(desktopRuntimeReleaseTag(root, version, commit)).toBe(`v${version}`);
  },
);

it("stamps official plugins only in the installed build", () => {
  const { root, commit } = fixture();
  const plan = planDesktopRuntimePlugins(root);
  expect(plan.pluginIds).toEqual(["codex", "extra"]);
  const installed = path.join(root, "installed");
  writeJson(installed, "dist/build-info.json", { commit, buildId: "fixture" });
  for (const id of plan.pluginIds) {
    writePlugin(installed, id);
  }
  stampDesktopRuntimePlugins(installed, plan);
  expect(readJson(installed, "dist/build-info.json")).toEqual({
    commit,
    buildId: "fixture",
    stagedOfficialPlugins: { commit, pluginIds: ["codex", "extra"] },
  });
  expect(readJson(root, "dist/build-info.json")).not.toHaveProperty("stagedOfficialPlugins");
});

it("lets a desktop stage only Codex without requiring other plugins' builds", () => {
  const { root, commit } = fixture();
  expect(planDesktopRuntimePlugins(root, { pluginIds: ["codex"] })).toMatchObject({
    commit,
    releaseTag: null,
    pluginIds: ["codex"],
  });
  git(root, "tag", "v2026.10.2");
  expect(planDesktopRuntimePlugins(root, { pluginIds: ["codex"] }).pluginIds).toEqual([]);
});

it.each([false, true])("excludes core dependencies from the 300 MiB budget (%s)", (inCore) => {
  const { root } = fixture(inCore ? { large: "1.0.0" } : undefined);
  writeJson(root, "extensions/extra/package.json", {
    name: "@openclaw/extra",
    dependencies: { large: "1.0.0" },
  });
  writeJson(root, "node_modules/large/package.json", {});
  const payload = path.join(root, "node_modules/large/payload");
  writeFileSync(payload, "");
  truncateSync(payload, 301 * 1024 * 1024);
  const plan = planDesktopRuntimePlugins(root);
  expect(plan.pluginIds).toEqual(inCore ? ["codex", "extra"] : ["codex"]);
  if (!inCore) {
    expect(plan.releaseTag).toBeNull();
  }
});

it("preserves exact release artifacts without source dependencies", () => {
  const { root } = fixture();
  git(root, "tag", "v2026.10.2");
  const before = readFileSync(path.join(root, "dist/build-info.json"));
  const plan = planDesktopRuntimePlugins(root);
  stampDesktopRuntimePlugins(root, plan);
  expect(plan.pluginIds).toEqual([]);
  expect(readFileSync(path.join(root, "dist/build-info.json"))).toEqual(before);
});

it("rejects artifacts built at a different source commit", () => {
  const { root } = fixture();
  writeJson(root, "dist/build-info.json", { commit: "0".repeat(40) });
  expect(() => planDesktopRuntimePlugins(root)).toThrow("current source commit");
});
