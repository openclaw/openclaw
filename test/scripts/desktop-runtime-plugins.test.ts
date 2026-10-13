import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopRuntimeReleaseTag,
  planDesktopRuntimePlugins,
  stampDesktopRuntimePlugins,
} from "../../scripts/lib/desktop-runtime-plugins.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const writeJson = (root: string, file: string, value: unknown) => {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value));
};
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function fixture() {
  const root = temps.make("desktop-runtime-plugins-");
  git(root, "init", "--quiet");
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  );
  const commit = git(root, "rev-parse", "HEAD");
  writeJson(root, "package.json", {
    name: "openclaw",
    version: "2026.10.2",
    files: ["!dist/extensions/codex/**", "!dist/extensions/extra/**"],
  });
  writeJson(root, "dist/build-info.json", { commit, version: "2026.10.2", buildId: "fixture" });
  writeJson(root, "scripts/lib/official-external-plugin-catalog.json", {
    entries: [{ name: "@openclaw/codex" }, { name: "@openclaw/extra" }],
  });
  for (const id of ["codex", "extra"]) {
    writeJson(root, `extensions/${id}/package.json`, { name: `@openclaw/${id}` });
    writeJson(root, `dist/extensions/${id}/package.json`, {
      name: `@openclaw/${id}`,
      openclaw: { extensions: ["./index.mjs"] },
    });
    writeFileSync(path.join(root, `dist/extensions/${id}/index.mjs`), "export {};\n");
  }
  return { root, commit };
}

describe("desktop runtime source plugins", () => {
  it.runIf(process.platform === "darwin")(
    "normalizes only staged Codex voice build rpaths",
    async () => {
      const { auditMacRuntimePortability } =
        await import("../../scripts/lib/mac-runtime-portability.mjs");
      const root = temps.make("desktop-runtime-codex-native-");
      const commit = "a".repeat(40);
      writeJson(root, "dist/build-info.json", { commit });
      writeJson(root, "dist/extensions/codex/package.json", {
        openclaw: { extensions: ["./index.mjs"] },
      });
      writeFileSync(path.join(root, "dist/extensions/codex/index.mjs"), "export {};\n");
      for (const name of ["codex", "codex-darwin-arm64"]) {
        writeJson(root, `node_modules/@openai/${name}/package.json`, { name: `@openai/${name}` });
      }
      const voice = path.join(
        root,
        "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-resources/voice",
      );
      mkdirSync(path.join(voice, "lib"), { recursive: true });
      mkdirSync(path.join(voice, "bin"));
      const host = path.join(voice, "bin/codex-voice-host");
      execFileSync(
        "/usr/bin/clang",
        [
          "-x",
          "c",
          "-",
          "-o",
          host,
          "-Wl,-rpath,@loader_path/../../_solib_darwin_arm64/voice/native_link_macos_aarch64",
          "-Wl,-rpath,@loader_path/../lib",
        ],
        { input: "int main(void) { return 0; }\n" },
      );
      const original = readFileSync(host);
      stampDesktopRuntimePlugins(root, { commit, pluginIds: [] });
      expect(readFileSync(host)).toEqual(original);
      expect(() => auditMacRuntimePortability(root, host)).toThrow("Nonportable LC_RPATH");
      stampDesktopRuntimePlugins(root, { commit, pluginIds: ["codex"] });
      expect(auditMacRuntimePortability(root, host)).toBe(1);
    },
  );

  it.each([
    [[], null],
    [["release/2026.10.2", "v2026.9.2"], null],
    [["v2026.10.2"], "v2026.10.2"],
    [["v2026.10.2", "v2026.10.2-1"], "v2026.10.2"],
  ])("recognizes only matching exact release source tags (%j)", (tags, expected) => {
    const { root, commit } = fixture();
    for (const tag of tags) {
      git(root, "tag", tag);
    }
    expect(desktopRuntimeReleaseTag(root, "2026.10.2", commit)).toBe(expected);
  });

  it("requires the correction release's base tag at the same commit", () => {
    const { root, commit } = fixture();
    git(root, "tag", "v2026.10.2-1");
    expect(() => desktopRuntimeReleaseTag(root, "2026.10.2", commit)).toThrow(
      "requires same-source base tag v2026.10.2",
    );
  });

  it.each(["2026.10.2-beta.1", "2026.10.2-alpha.1", "2026.10.33"])(
    "recognizes the canonical exact release version %s",
    (version) => {
      const { root, commit } = fixture();
      git(root, "tag", `v${version}`);
      expect(desktopRuntimeReleaseTag(root, version, commit)).toBe(`v${version}`);
    },
  );

  it("does not classify a commit after a release tag as a release", () => {
    const { root } = fixture();
    git(root, "tag", "v2026.10.2");
    git(
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "next",
    );
    expect(desktopRuntimeReleaseTag(root, "2026.10.2", git(root, "rev-parse", "HEAD"))).toBeNull();
  });

  it("stages all official source plugins and stamps the installed build only", () => {
    const { root, commit } = fixture();
    const plan = planDesktopRuntimePlugins(root);
    expect(plan.pluginIds).toEqual(["codex", "extra"]);
    const installed = path.join(root, "installed");
    writeJson(installed, "dist/build-info.json", { commit, buildId: "fixture" });
    for (const id of plan.pluginIds) {
      writeJson(installed, `dist/extensions/${id}/package.json`, {
        openclaw: { extensions: ["./index.mjs"] },
      });
      writeFileSync(path.join(installed, `dist/extensions/${id}/index.mjs`), "export {};\n");
    }
    stampDesktopRuntimePlugins(installed, plan);
    expect(JSON.parse(readFileSync(path.join(installed, "dist/build-info.json"), "utf8"))).toEqual({
      commit,
      buildId: "fixture",
      stagedOfficialPlugins: { commit, pluginIds: ["codex", "extra"] },
    });
    expect(
      JSON.parse(readFileSync(path.join(root, "dist/build-info.json"), "utf8")),
    ).not.toHaveProperty("stagedOfficialPlugins");
  });

  it("counts additional transitive dependencies and falls back to first-run Codex above 300 MiB", () => {
    const { root } = fixture();
    writeJson(root, "extensions/extra/package.json", {
      name: "@openclaw/extra",
      dependencies: { large: "1.0.0" },
    });
    writeJson(root, "node_modules/large/package.json", { name: "large", version: "1.0.0" });
    const payload = path.join(root, "node_modules/large/payload");
    writeFileSync(payload, "");
    truncateSync(payload, 301 * 1024 * 1024);
    expect(planDesktopRuntimePlugins(root)).toMatchObject({
      pluginIds: ["codex"],
      releaseTag: null,
    });
  });

  it("does not count dependencies already shipped by core against the extra payload", () => {
    const { root } = fixture();
    writeJson(root, "package.json", {
      name: "openclaw",
      version: "2026.10.2",
      files: ["!dist/extensions/codex/**", "!dist/extensions/extra/**"],
      dependencies: { large: "1.0.0" },
    });
    writeJson(root, "extensions/extra/package.json", {
      name: "@openclaw/extra",
      dependencies: { large: "1.0.0" },
    });
    writeJson(root, "node_modules/large/package.json", { name: "large", version: "1.0.0" });
    const payload = path.join(root, "node_modules/large/payload");
    writeFileSync(payload, "");
    truncateSync(payload, 301 * 1024 * 1024);
    expect(planDesktopRuntimePlugins(root).pluginIds).toEqual(["codex", "extra"]);
  });

  it("keeps exact release artifacts unchanged without requiring source dependencies", () => {
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
});
