import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBuiltArtifactPermissions,
  normalizeBuildArtifactPermissions,
} from "../../scripts/check-artifact-permissions.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const sha = "a".repeat(40);
function fixture() {
  const rootDir = createTempDir("openclaw-artifact-plan-");
  // Fixture artifacts start with distribution modes, independent of host setgid inheritance.
  fs.chmodSync(rootDir, 0o755);
  const files = {
    "package.json": '{"name":"openclaw","type":"module"}',
    "tsdown.config.ts":
      'export default [{entry:{entry:"src/entry.ts","private-module":"src/private-module.ts"},outDir:"dist",outExtensions:()=>({js:".js"})}];',
    "extensions/demo/package.json": JSON.stringify({
      name: "@openclaw/demo",
      openclaw: {
        extensions: ["./index.ts"],
        build: { staticAssets: [{ source: "assets/help.txt", output: "assets/help.txt" }] },
      },
    }),
    "extensions/demo/openclaw.plugin.json": JSON.stringify({
      id: "demo",
      controlUi: {
        entry: "dist/control-ui/generation/index.js",
        styles: ["dist/control-ui/generation/index.css"],
      },
    }),
    "extensions/demo/index.ts": "export {};\n",
    "dist/entry.js": "export {};\n",
    "dist/private-module.js": "export {};\n",
    "dist/control-ui/index.html": "<html></html>\n",
    "dist/extensions/demo/index.js": "export {};\n",
    "dist/extensions/demo/package.json": '{"name":"@openclaw/demo","type":"module"}',
    "dist/extensions/demo/openclaw.plugin.json": JSON.stringify({
      id: "demo",
      controlUi: {
        entry: "dist/control-ui/generation/index.js",
        styles: ["dist/control-ui/generation/index.css"],
      },
    }),
    "dist/extensions/demo/dist/control-ui/generation/index.js": "export {};\n",
    "dist/extensions/demo/dist/control-ui/generation/index.css": "body {}\n",
    "dist/extensions/demo/assets/help.txt": "help\n",
  };
  for (const [file, bytes] of Object.entries(files)) {
    const target = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    if (file.startsWith("dist/extensions/")) {
      const overlay = path.join(
        rootDir,
        file.replace(/^dist\/extensions\//u, "dist-runtime/extensions/"),
      );
      fs.mkdirSync(path.dirname(overlay), { recursive: true });
      fs.writeFileSync(overlay, bytes);
    }
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_COMMIT: sha,
    OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: undefined,
    OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: undefined,
    OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: undefined,
  };
  return { rootDir, env };
}

describe("finished artifact acceptance", () => {
  it("records deliberately skipped plugin assets without weakening finished-image acceptance", async () => {
    const params = fixture();
    params.env.OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS = "0";
    const plan = await normalizeBuildArtifactPermissions(params);
    expect(plan.staticAssets).toBe(false);
    expect(plan.plugins[0]?.controlUi).toMatchObject({
      entry: "dist/control-ui/generation/index.js",
    });
    expect(plan.requiredFiles).not.toContain(
      "dist/extensions/demo/dist/control-ui/generation/index.js",
    );
    expect(plan.requiredFiles).not.toContain("dist/extensions/demo/assets/help.txt");
    // Surviving assets do not promote a partial build into an image contract.
    expect(() => assertBuiltArtifactPermissions({ ...params, image: true })).toThrow(
      /complete static asset build contract/u,
    );
    for (const prefix of ["dist/extensions/demo", "dist-runtime/extensions/demo"]) {
      fs.rmSync(path.join(params.rootDir, prefix, "dist/control-ui"), { recursive: true });
      fs.unlinkSync(path.join(params.rootDir, prefix, "assets/help.txt"));
    }
    fs.rmSync(path.join(params.rootDir, "dist/control-ui"), { recursive: true });
    await normalizeBuildArtifactPermissions(params);
    // Acceptance consumes the recorded producer contract, not the checking shell's env.
    expect(assertBuiltArtifactPermissions({ ...params, env: { GIT_COMMIT: sha } })).toMatchObject({
      planState: "verified",
      plugins: 1,
    });
  });

  it("replaces a skipped contract on return to full assets and rejects stale prior UI generations", async () => {
    const params = fixture();
    await normalizeBuildArtifactPermissions(params);
    await normalizeBuildArtifactPermissions({
      ...params,
      env: { ...params.env, OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" },
    });
    const manifest = {
      id: "demo",
      controlUi: { entry: "dist/control-ui/next-generation/index.js" },
    };
    for (const prefix of ["extensions", "dist/extensions", "dist-runtime/extensions"]) {
      fs.writeFileSync(
        path.join(params.rootDir, prefix, "demo/openclaw.plugin.json"),
        JSON.stringify(manifest),
      );
    }
    const full = await normalizeBuildArtifactPermissions(params);
    expect(full.staticAssets).toBe(true);
    expect(full.requiredFiles).toContain(
      "dist/extensions/demo/dist/control-ui/next-generation/index.js",
    );
    expect(() => assertBuiltArtifactPermissions(params)).toThrow(
      "dist/extensions/demo/dist/control-ui/next-generation/index.js",
    );
    for (const prefix of ["dist/extensions", "dist-runtime/extensions"]) {
      const target = path.join(params.rootDir, prefix, "demo", manifest.controlUi.entry);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "export {};\n");
    }
    await normalizeBuildArtifactPermissions(params);
    expect(assertBuiltArtifactPermissions(params)).toMatchObject({ planState: "verified" });
    fs.unlinkSync(path.join(params.rootDir, "dist/extensions/demo/assets/help.txt"));
    await normalizeBuildArtifactPermissions(params);
    expect(() => assertBuiltArtifactPermissions(params)).toThrow(
      "dist/extensions/demo/assets/help.txt",
    );
  });

  it("records compiler and plugin membership independently of surviving outputs and repairs only generated modes", async () => {
    const params = fixture();
    const source = path.join(params.rootDir, "extensions/demo");
    fs.chmodSync(source, 0o700);
    fs.chmodSync(path.join(source, "index.ts"), 0o600);
    const built = path.join(params.rootDir, "dist/extensions/demo/dist/control-ui");
    fs.chmodSync(built, 0o700);
    fs.chmodSync(path.join(built, "generation/index.js"), 0o600);
    const plan = await normalizeBuildArtifactPermissions(params);
    expect(plan.requiredFiles).toContain("dist/private-module.js");
    expect(plan.plugins).toMatchObject([
      {
        id: "demo",
        root: "dist/extensions/demo",
        controlUi: { entry: "dist/control-ui/generation/index.js" },
      },
    ]);
    expect(assertBuiltArtifactPermissions(params)).toMatchObject({
      schemaVersion: 1,
      sourceSha: sha,
      plugins: 1,
      planState: "verified",
    });
    expect(fs.readFileSync(path.join(source, "index.ts"), "utf8")).toBe("export {};\n");
    if (process.platform !== "win32") {
      expect(fs.statSync(source).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(source, "index.ts")).mode & 0o777).toBe(0o600);
    }
    fs.rmSync(path.join(params.rootDir, "dist/extensions/demo"), { recursive: true });
    await normalizeBuildArtifactPermissions(params);
    expect(() => assertBuiltArtifactPermissions(params)).toThrow(
      /Missing required runtime artifact/u,
    );
  });

  it("rejects whole private-module omission after a warm rebuild instead of blessing existing files", async () => {
    const params = fixture();
    await normalizeBuildArtifactPermissions(params);
    fs.unlinkSync(path.join(params.rootDir, "dist/private-module.js"));
    await normalizeBuildArtifactPermissions(params);
    expect(() => assertBuiltArtifactPermissions(params)).toThrow("dist/private-module.js");
  });

  it("checks a finished image without its source inventory or loader and never repairs its inputs", async () => {
    const params = fixture();
    await normalizeBuildArtifactPermissions(params);
    for (const directory of ["extensions", "tsdown.config.ts"]) {
      fs.rmSync(path.join(params.rootDir, directory), { recursive: true });
    }
    // Mounted proof needs exactly this zero-dependency runtime import closure.
    const checker = path.join(params.rootDir, "scripts/check-artifact-permissions.mts");
    const helper = path.join(params.rootDir, "src/shared/artifact-permissions.ts");
    fs.mkdirSync(path.dirname(checker), { recursive: true });
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), "scripts/check-artifact-permissions.mts"), checker);
    fs.copyFileSync(path.join(process.cwd(), "src/shared/artifact-permissions.ts"), helper);
    fs.chmodSync(params.rootDir, 0o755);
    const output = execFileSync(
      process.execPath,
      [checker, "--root", params.rootDir, "--image", "--read-files", "--source-sha", sha],
      { encoding: "utf8", env: params.env },
    );
    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: 1,
      readFiles: true,
      sourceSha: sha,
      plugins: 1,
      planState: "verified",
    });
    const planPath = path.join(params.rootDir, "dist/runtime-artifact-plan.json");
    const planBytes = fs.readFileSync(planPath, "utf8");
    const plan = JSON.parse(planBytes);
    plan.sourceSha = [sha];
    fs.writeFileSync(planPath, JSON.stringify(plan));
    expect(() => assertBuiltArtifactPermissions({ ...params, image: true })).toThrow(
      /source SHA must be a string/u,
    );
    delete plan.sourceSha;
    fs.writeFileSync(planPath, JSON.stringify(plan));
    expect(assertBuiltArtifactPermissions({ ...params, image: true, env: {} })).not.toHaveProperty(
      "sourceSha",
    );
    fs.writeFileSync(planPath, planBytes);
    expect(assertBuiltArtifactPermissions({ ...params, image: true })).toMatchObject({
      sourceSha: sha,
      planState: "verified",
    });
    const extra = path.join(params.rootDir, "dist/extensions/unexpected");
    fs.mkdirSync(extra);
    expect(() => assertBuiltArtifactPermissions({ ...params, image: true })).toThrow(/membership/u);
    fs.rmSync(extra, { recursive: true });
    const binary = path.join(params.rootDir, "node_modules/fixture/bin/run.js");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(
      path.join(params.rootDir, "node_modules/fixture/package.json"),
      '{"name":"fixture","bin":"bin/run.js"}',
    );
    fs.writeFileSync(binary, "#!/usr/bin/env node\n", { mode: 0o644 });
    if (process.platform !== "win32") {
      expect(() => assertBuiltArtifactPermissions({ ...params, image: true })).toThrow(
        /executable/u,
      );
    }
    fs.chmodSync(binary, 0o755);
    expect(assertBuiltArtifactPermissions({ ...params, image: true })).toMatchObject({
      planState: "verified",
    });
    const blocked = path.join(params.rootDir, "dist/control-ui");
    fs.chmodSync(blocked, 0o700);
    if (process.platform !== "win32") {
      expect(() =>
        assertBuiltArtifactPermissions({ ...params, image: true, readFiles: true }),
      ).toThrow(/world/u);
      expect(fs.statSync(blocked).mode & 0o777).toBe(0o700);
    }
    expect(() =>
      assertBuiltArtifactPermissions({ ...params, image: true, sourceSha: "b".repeat(40) }),
    ).toThrow(/expected source SHA/u);
  });

  it("requires persisted membership, with an explicitly labeled legacy-only fallback", () => {
    const params = fixture();
    expect(() => assertBuiltArtifactPermissions({ ...params, image: true })).toThrow(
      /artifact plan/u,
    );
    fs.chmodSync(params.rootDir, 0o755);
    expect(
      assertBuiltArtifactPermissions({ ...params, image: true, legacySource: true }),
    ).toMatchObject({ planState: "legacy-source" });
  });
});
