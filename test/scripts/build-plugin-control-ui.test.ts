import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { acquireDistArtifactOwnership } from "../../scripts/lib/dist-artifact-lock.mts";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "../../scripts/lib/dist-artifact-ownership.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("serializes concurrent Settings builders with checkout artifact writers", async ({ signal }) => {
  const root = tempDirs.make("openclaw-settings-build-");
  const pluginRoot = path.join(root, "extensions", "fixture");
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({
      name: "@openclaw/fixture",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.ts"], controlUi: "./browser.ts" },
    }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      controlUi: {
        entry: "dist/control-ui/source/index.js",
        activation: "settings-only",
        settingsViews: [{ section: "memory", panel: "overview" }],
      },
    }),
  );
  fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export {};");
  fs.writeFileSync(path.join(pluginRoot, "browser.ts"), 'export default {label: "Fixture"};');
  const sdkRoot = path.join(root, "dist", "plugin-sdk");
  fs.mkdirSync(sdkRoot, { recursive: true });
  fs.writeFileSync(path.join(sdkRoot, "provider-usage.js"), "export const usage = 42;");

  const lock = await acquireDistArtifactOwnership(root);
  const builders = [0, 1].map(() => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        path.resolve("scripts/build-plugin-control-ui.mts"),
        "--prepare-settings",
        root,
      ],
      { cwd: root, signal, stdio: ["ignore", "ignore", "pipe"] },
    );
    let output = "";
    const waiting = new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("waiting for checkout ownership:")) {
          resolve();
        }
      });
      child.once("error", reject);
      child.once("close", () => reject(new Error(`Builder did not wait: ${output}`)));
    });
    const done = new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    return { waiting, done, output: () => output };
  });
  try {
    await Promise.all(builders.map((builder) => builder.waiting));
    expect(fs.existsSync(path.join(pluginRoot, "dist"))).toBe(false);
  } finally {
    await lock.release();
    const codes = await Promise.all(builders.map((builder) => builder.done));
    expect(codes, builders.map((builder) => builder.output()).join("\n")).toEqual([0, 0]);
  }
  const distribution = path.join(root, "dist", "extensions", "fixture");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(distribution, "openclaw.plugin.json"), "utf8"),
  );
  expect(manifest.controlUi.settingsViews).toEqual([{ section: "memory", panel: "overview" }]);
  expect(fs.readFileSync(path.join(distribution, manifest.controlUi.entry), "utf8")).toContain(
    "Fixture",
  );
  const alias = path.join(
    root,
    "dist/extensions/node_modules/openclaw/plugin-sdk/provider-usage.js",
  );
  expect(fs.readFileSync(alias, "utf8")).toContain(
    'export * from "../../../../plugin-sdk/provider-usage.js"',
  );

  // Vite invokes buildStart from native bundler callbacks after its CLI import returns.
  const configPath = path.join(root, "vite.config.mts");
  const preparer = pathToFileURL(path.resolve("scripts/lib/prepare-control-ui-settings.mts")).href;
  fs.writeFileSync(
    configPath,
    `import { prepareControlUiSettings } from ${JSON.stringify(preparer)};
export default { plugins: [{ name: "settings", async buildStart() {
  await prepareControlUiSettings(${JSON.stringify(root)});
} }] };`,
  );
  fs.writeFileSync(
    path.join(root, "index.html"),
    '<script type="module" src="./extensions/fixture/browser.ts"></script>',
  );
  await withDistArtifactOwnership(root, () =>
    promisify(execFile)(
      process.execPath,
      distArtifactEntryArgs(
        path.resolve("node_modules/vite/bin/vite.js"),
        ["build", "--config", configPath, "--outDir", path.join(root, "ui-output")],
        { native: true },
      ),
      { cwd: root, signal },
    ),
  );
  expect(fs.readFileSync(path.join(root, "ui-output/index.html"), "utf8")).toContain("/assets/");

  const ownerUrl = pathToFileURL(path.resolve("scripts/lib/dist-artifact-ownership.mts")).href;
  const buildAllUrl = pathToFileURL(path.resolve("scripts/build-all.mts")).href;
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(
    path.join(root, "scripts/ui.js"),
    `import fs from "node:fs";
import { withDistArtifactOwnership } from ${JSON.stringify(ownerUrl)};
await withDistArtifactOwnership(process.cwd(), async () => fs.writeFileSync("ui-step-complete", "ok"));`,
  );
  const buildAll = path.join(root, "build-all.mts");
  fs.writeFileSync(
    buildAll,
    `import { withDistArtifactOwnership } from ${JSON.stringify(ownerUrl)};
import { runBuildAllSteps } from ${JSON.stringify(buildAllUrl)};
const result = await withDistArtifactOwnership(process.cwd(), () => runBuildAllSteps("full", {
  cacheEnabled: false,
  env: { ...process.env, GIT_COMMIT: "${"a".repeat(40)}", OPENCLAW_BUILD_TIMESTAMP: "2026-10-17T00:00:00.000Z" },
  steps: [{ label: "ui:build", args: ["scripts/ui.js", "build"] }],
}));
if (result.exitCode !== 0) throw new Error("UI build step failed");`,
  );
  await promisify(execFile)(
    process.execPath,
    ["--import", path.resolve("scripts/tsx.mjs"), buildAll],
    {
      cwd: root,
      signal,
    },
  );
  expect(fs.readFileSync(path.join(root, "ui-step-complete"), "utf8")).toBe("ok");
});

it("rebuilds browser assets without invalidating unchanged manifest inputs", () => {
  const rootDir = tempDirs.make("openclaw-control-ui-script-");
  fs.symlinkSync(path.resolve("node_modules"), path.join(rootDir, "node_modules"), "junction");
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", openclaw: { controlUi: "browser.ts" } }),
  );
  const manifestPath = path.join(rootDir, "openclaw.plugin.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ id: "fixture" }));
  const authoredManifest = fs.readFileSync(manifestPath, "utf8");
  const generatedManifestPath = path.join(rootDir, "dist", "openclaw.plugin.json");
  fs.writeFileSync(
    path.join(rootDir, "browser.ts"),
    'import "./browser.css"; export const label = "Fixture";\n',
  );
  fs.writeFileSync(path.join(rootDir, "browser.css"), ".fixture { color: red; }\n");
  const build = () =>
    execFileSync(
      process.execPath,
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        path.resolve("scripts/build-plugin-control-ui.mts"),
        rootDir,
      ],
      { timeout: 10_000, stdio: "pipe" },
    );

  build();
  expect(fs.readFileSync(manifestPath, "utf8")).toBe(authoredManifest);
  const generatedManifest = JSON.parse(fs.readFileSync(generatedManifestPath, "utf8"));
  const { entry, styles } = generatedManifest.controlUi;
  const compactManifest = JSON.stringify({
    id: "fixture",
    categories: ["channels"],
    controlUi: { styles, entry },
  });
  const assetPath = path.join(rootDir, entry);
  const asset = fs.readFileSync(assetPath, "utf8");
  // External runtime compilation clears dist after the asset phase snapshots
  // source identity. Rebuilding must restore assets without republishing that input.
  for (const manifest of [authoredManifest, compactManifest]) {
    fs.writeFileSync(manifestPath, manifest);
    const before = fs.statSync(manifestPath, { bigint: true });
    fs.rmSync(path.join(rootDir, "dist"), { recursive: true });
    build();

    expect(fs.readFileSync(assetPath, "utf8")).toBe(asset);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(manifest);
    expect(JSON.parse(fs.readFileSync(generatedManifestPath, "utf8")).controlUi).toEqual(
      generatedManifest.controlUi,
    );
    const after = fs.statSync(manifestPath, { bigint: true });
    expect({ ino: after.ino, ctimeNs: after.ctimeNs }).toEqual({
      ino: before.ino,
      ctimeNs: before.ctimeNs,
    });
  }

  // Generated publication retains the atomic writer's refusal of linked destinations.
  const linkedManifest = path.join(rootDir, "linked-manifest.json");
  fs.renameSync(generatedManifestPath, linkedManifest);
  fs.symlinkSync(linkedManifest, generatedManifestPath, "file");
  expect(build).toThrow("atomic replace destination must not be a symbolic link");
});
