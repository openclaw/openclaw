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
const tsx = path.resolve("scripts/tsx.mjs");
const buildScript = path.resolve("scripts/build-plugin-control-ui.mts");
const moduleUrl = (file: string) => pathToFileURL(path.resolve(file)).href;
function fixtureFiles(root: string) {
  const at = (file: string) => path.join(root, file);
  return {
    at,
    read: (file: string) => fs.readFileSync(at(file), "utf8"),
    json: (file: string) => JSON.parse(fs.readFileSync(at(file), "utf8")),
    write(file: string, value: string | object) {
      fs.mkdirSync(path.dirname(at(file)), { recursive: true });
      fs.writeFileSync(at(file), typeof value === "string" ? value : JSON.stringify(value));
    },
  };
}

it("serializes concurrent Settings builders with checkout artifact writers", async ({ signal }) => {
  const root = tempDirs.make("openclaw-settings-build-");
  const files = fixtureFiles(root);
  const plugin = fixtureFiles(files.at("extensions/fixture"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  files.write("package.json", { type: "module" });
  plugin.write("package.json", {
    name: "@openclaw/fixture",
    type: "module",
    openclaw: { extensions: ["./index.ts"], controlUi: "./browser.ts" },
  });
  plugin.write("openclaw.plugin.json", {
    id: "fixture",
    configSchema: { type: "object" },
    controlUi: {
      entry: "dist/control-ui/source/index.js",
      activation: "settings-only",
      settingsViews: [{ section: "memory", panel: "overview" }],
    },
  });
  plugin.write("index.ts", "export {};");
  plugin.write("browser.ts", 'export default {label: "Fixture"};');
  files.write("dist/plugin-sdk/provider-usage.js", "export const usage = 42;");

  const lock = await acquireDistArtifactOwnership(root);
  const builders = [0, 1].map(() => {
    const child = spawn(
      process.execPath,
      ["--import", tsx, buildScript, "--prepare-settings", root],
      {
        cwd: root,
        signal,
        stdio: ["ignore", "ignore", "pipe"],
      },
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
    expect(fs.existsSync(plugin.at("dist"))).toBe(false);
  } finally {
    await lock.release();
    const codes = await Promise.all(builders.map((builder) => builder.done));
    expect(codes, builders.map((builder) => builder.output()).join("\n")).toEqual([0, 0]);
  }
  const distribution = fixtureFiles(files.at("dist/extensions/fixture"));
  const manifest = distribution.json("openclaw.plugin.json");
  expect(manifest.controlUi.settingsViews).toEqual([{ section: "memory", panel: "overview" }]);
  expect(distribution.read(manifest.controlUi.entry)).toContain("Fixture");
  expect(
    files.read("dist/extensions/node_modules/openclaw/plugin-sdk/provider-usage.js"),
  ).toContain('export * from "../../../../plugin-sdk/provider-usage.js"');

  // Vite invokes buildStart from native bundler callbacks after its CLI import returns.
  const configPath = files.at("vite.config.mts");
  const preparer = moduleUrl("scripts/lib/prepare-control-ui-settings.mts");
  files.write(
    "vite.config.mts",
    `import { prepareControlUiSettings } from ${JSON.stringify(preparer)};
export default { plugins: [{ name: "settings", async buildStart() {
  await prepareControlUiSettings(${JSON.stringify(root)});
} }] };`,
  );
  files.write(
    "index.html",
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
  expect(files.read("ui-output/index.html")).toContain("/assets/");

  const ownerUrl = moduleUrl("scripts/lib/dist-artifact-ownership.mts");
  const buildAllUrl = moduleUrl("scripts/build-all.mts");
  files.write(
    "scripts/ui.js",
    `import fs from "node:fs";
import { withDistArtifactOwnership } from ${JSON.stringify(ownerUrl)};
await withDistArtifactOwnership(process.cwd(), async () => fs.writeFileSync("ui-step-complete", "ok"));`,
  );
  files.write(
    "build-all.mts",
    `import { withDistArtifactOwnership } from ${JSON.stringify(ownerUrl)};
import { runBuildAllSteps } from ${JSON.stringify(buildAllUrl)};
const result = await withDistArtifactOwnership(process.cwd(), () => runBuildAllSteps("full", {
  cacheEnabled: false,
  // This fixture runs one tiny UI writer; host pressure must not gate the lock handoff proof.
  memoryLimit: {
    availableMemoryBytes: 16 * 1024 ** 3,
    procMemTotalBytes: 16 * 1024 ** 3,
    cgroupMemoryLimitBytes: 16 * 1024 ** 3,
  },
  env: { ...process.env, GIT_COMMIT: "${"a".repeat(40)}", OPENCLAW_BUILD_TIMESTAMP: "2026-10-17T00:00:00.000Z" },
  steps: [{ label: "ui:build", args: ["scripts/ui.js", "build"] }],
}));
if (result.exitCode !== 0) throw new Error("UI build step failed");`,
  );
  await promisify(execFile)(process.execPath, ["--import", tsx, files.at("build-all.mts")], {
    cwd: root,
    signal,
  });
  expect(files.read("ui-step-complete")).toBe("ok");
});

it("rebuilds browser assets without invalidating unchanged manifest inputs", () => {
  const rootDir = tempDirs.make("openclaw-control-ui-script-");
  const files = fixtureFiles(rootDir);
  fs.symlinkSync(path.resolve("node_modules"), path.join(rootDir, "node_modules"), "junction");
  files.write("package.json", {
    type: "module",
    openclaw: { controlUi: "browser.ts" },
  });
  const manifestPath = files.at("openclaw.plugin.json");
  files.write("openclaw.plugin.json", { id: "fixture" });
  const authoredManifest = files.read("openclaw.plugin.json");
  const generatedManifestPath = files.at("dist/openclaw.plugin.json");
  files.write("browser.ts", 'import "./browser.css"; export const label = "Fixture";\n');
  files.write("browser.css", ".fixture { color: red; }\n");
  const build = () =>
    execFileSync(process.execPath, ["--import", tsx, buildScript, rootDir], {
      timeout: 10_000,
      stdio: "pipe",
    });

  build();
  expect(files.read("openclaw.plugin.json")).toBe(authoredManifest);
  const generatedManifest = files.json("dist/openclaw.plugin.json");
  const { entry, styles } = generatedManifest.controlUi;
  const compactManifest = JSON.stringify({
    id: "fixture",
    categories: ["channels"],
    controlUi: { styles, entry },
  });
  const asset = files.read(entry);
  // External runtime compilation clears dist after the asset phase snapshots
  // source identity. Rebuilding must restore assets without republishing that input.
  for (const manifest of [authoredManifest, compactManifest]) {
    fs.writeFileSync(manifestPath, manifest);
    const before = fs.statSync(manifestPath, { bigint: true });
    fs.rmSync(path.join(rootDir, "dist"), { recursive: true });
    build();

    expect(files.read(entry)).toBe(asset);
    expect(files.read("openclaw.plugin.json")).toBe(manifest);
    expect(files.json("dist/openclaw.plugin.json").controlUi).toEqual(generatedManifest.controlUi);
    const after = fs.statSync(manifestPath, { bigint: true });
    expect(after).toMatchObject({ ino: before.ino, ctimeNs: before.ctimeNs });
  }

  // Generated publication retains the atomic writer's refusal of linked destinations.
  const linkedManifest = path.join(rootDir, "linked-manifest.json");
  fs.renameSync(generatedManifestPath, linkedManifest);
  fs.symlinkSync(linkedManifest, generatedManifestPath, "file");
  expect(build).toThrow("atomic replace destination must not be a symbolic link");
});
