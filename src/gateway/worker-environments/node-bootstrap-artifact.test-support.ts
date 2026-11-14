import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createNodeBootstrapArtifactProvider } from "./node-bootstrap-artifact.js";

// mock-isolation: archive fixtures have synthetic registry dependencies; install-lock tests own npm I/O.
vi.mock("./node-bootstrap-install-lock.js", () => ({
  prepareNodeBootstrapInstallLock: async () => undefined,
}));

export const buildId = "fixture-source-build";
export const version = "2026.8.1";
export const longEntryPath = `dist/${"entry-".repeat(25)}.json`;
export const longEntryPayload = "payload".repeat(90);

export async function write(root: string, relative: string, contents: string | object) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, typeof contents === "string" ? contents : JSON.stringify(contents));
}

export async function writeFiles(root: string, files: Record<string, string | object>) {
  for (const [relative, contents] of Object.entries(files)) {
    await write(root, relative, contents);
  }
}

export const readText = (root: string, relative: string) =>
  fs.readFile(path.join(root, relative), "utf8");

export async function expectFiles(root: string, files: Record<string, string>) {
  for (const [relative, text] of Object.entries(files)) {
    expect(await readText(root, relative), relative).toBe(text);
  }
}

export async function expectMissing(root: string, files: string[]) {
  for (const relative of files) {
    await expect(fs.access(path.join(root, relative)), relative).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  }
}

export async function extract(root: string, artifact: { tarballPath: string }) {
  const installed = path.join(root, "node");
  await fs.mkdir(installed);
  await tar.extract({ file: artifact.tarballPath, cwd: installed });
  return path.join(installed, "package");
}

export type OwnedRuntimeChunk = { source: string; extensions: readonly string[] };

export async function writeOwnedChunks(
  packageRoot: string,
  chunks: Record<string, OwnedRuntimeChunk>,
) {
  for (const [file, chunk] of Object.entries(chunks)) {
    await write(packageRoot, `dist/${file}`, chunk.source);
  }
  await write(packageRoot, "dist/runtime-dependency-ownership.json", {
    chunks: Object.fromEntries(
      Object.entries(chunks).map(([file, chunk]) => [
        file,
        {
          sha256: createHash("sha256").update(chunk.source).digest("hex"),
          extensions: chunk.extensions,
        },
      ]),
    ),
  });
}

export async function writeBundledBrowser(packageRoot: string) {
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.dependencies["@fixture/browser"] = version;
  manifest.bundleDependencies = ["@fixture/browser"];
  await write(packageRoot, "package.json", manifest);
  const browserRoot = path.join(packageRoot, "node_modules/@fixture/browser");
  await write(browserRoot, "package.json", {
    name: "@fixture/browser",
    version,
    type: "module",
    main: "./build/src/index.js",
    bin: { browser: "./build/src/bin/browser.js" },
    files: ["build/src", "LICENSE", "skills", "!*.js.map"],
  });
  await writeFiles(browserRoot, {
    "build/src/index.js":
      'import { readFileSync } from "node:fs"; export const notice = readFileSync(new URL("./third_party/THIRD_PARTY_NOTICES", import.meta.url), "utf8");',
    "build/src/bin/browser.js": 'import { notice } from "../index.js"; console.log(notice);',
    "build/src/third_party/THIRD_PARTY_NOTICES": "bundled-notice",
    "build/src/OPENCLAW_PATCH_NOTICE.md": "patched-runtime",
    "skills/browser/SKILL.md": "browser-skill",
    LICENSE: "fixture-license",
  });
  return browserRoot;
}

export function useNodeBootstrapArtifactFixtures() {
  const providers: ReturnType<typeof createNodeBootstrapArtifactProvider>[] = [];
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await Promise.all(providers.splice(0).map((provider) => provider.close()));
      cleanup();
    }),
  );
  const createProvider = (options: Parameters<typeof createNodeBootstrapArtifactProvider>[0]) => {
    const provider = createNodeBootstrapArtifactProvider({ install: "npm", ...options });
    providers.push(provider);
    return provider;
  };
  async function fixture(
    mode: "source" | "package" | "external-plugin" | "linked-package" = "source",
  ) {
    const root = tempDirs.make("node-artifact-test-");
    const packageRoot = path.join(root, "gateway");
    const pluginPackage = {
      name: "@fixture/remote-runtime",
      version,
      type: "module",
      dependencies: { "native-runtime": "1.2.3" },
      openclaw: { extensions: ["./index.ts"] },
    };
    const sourcePackage = {
      name: "openclaw",
      version,
      type: "module",
      files: [
        "openclaw.mjs",
        "node-version.mjs",
        "node-sqlite.mjs",
        "node-runtime-update.mjs",
        "node-runtime-recovery.mjs",
        "cli-parent-lifetime.mjs",
        "node-runtime-env.mjs",
        "cli-invocation.mjs",
        "cli-root-options.mjs",
        "gateway-run-argv.mjs",
        "gateway-shutdown-budget.mjs",
        "node-host-launcher.mjs",
        "node-compile-cache.mjs",
        "dist/",
        "!dist/extensions/remote-runtime/**",
        "scripts/preinstall.mjs",
        "scripts/postinstall.mjs",
      ],
      dependencies: { "@fixture/ai": mode === "source" ? "workspace:*" : version },
      bundleDependencies: mode === "source" ? false : ["@fixture/ai"],
      devDependencies: { "typescript-only": "workspace:*" },
      scripts: {
        prepare: "exit 91",
        prepack: "exit 92",
        preinstall: "node scripts/preinstall.mjs",
        postinstall: "node scripts/postinstall.mjs",
      },
    };
    await write(packageRoot, "package.json", sourcePackage);
    await fs.writeFile(
      path.join(packageRoot, "openclaw.mjs"),
      'import "./cli-invocation.mjs"; import "./dist/entry.js";',
      { mode: 0o755 },
    );
    for (const filename of [
      "cli-invocation.mjs",
      "cli-parent-lifetime.mjs",
      "gateway-shutdown-budget.mjs",
      "node-runtime-env.mjs",
    ]) {
      await fs.copyFile(filename, path.join(packageRoot, filename));
    }
    await writeFiles(packageRoot, {
      "node-version.mjs": "export const supported = true;",
      "node-sqlite.mjs": "export const probe = true;",
      "node-runtime-update.mjs": "export const update = true;",
      "node-runtime-recovery.mjs": "export const recovery = true;",
      "cli-root-options.mjs": "export {};",
      "gateway-run-argv.mjs": "export {};",
      "node-host-launcher.mjs": "export const launcher = true;",
      "node-compile-cache.mjs": "export {};",
      "scripts/preinstall.mjs": "export {};\n",
      "scripts/postinstall.mjs":
        'import { rmSync } from "node:fs"; rmSync(new URL("../.openclaw-lifecycle-pending", import.meta.url));',
      "dist/entry.js":
        'import { answer } from "./extensions/remote-runtime/index.js"; import { name } from "../node_modules/@fixture/ai/dist/index.js"; console.log(`${name}:${answer}`);',
      "dist/control-ui/index.html": "<title>Gateway dashboard</title>",
      "dist/control-ui/assets/app.js": 'console.log("gateway-ui");',
      "dist/shared.js": 'export const answer = "cloud-ready";',
      "dist/empty.js": "",
      [longEntryPath]: { payload: longEntryPayload },
      "dist/worker/worker.mjs": 'console.log("separate-worker-bundle");',
      "dist/worker/workspace-rsync-receiver.mjs": "export {};",
      "dist/worker/github-exec-launcher.mjs": "export {};",
      "dist/worker-artifacts/fixture.tgz": "separate-worker-archive",
      "dist/build-info.json": { version, buildId },
      "dist/extensions/remote-runtime/package.json": pluginPackage,
      "dist/extensions/remote-runtime/openclaw.plugin.json": { id: "remote-runtime" },
      "dist/extensions/remote-runtime/index.js": 'export { answer } from "../../shared.js";',
      "dist/extensions/remote-runtime/node_modules/native-runtime/vendor/host-native":
        "do-not-transfer-native",
      "dist/.buildstamp": "local-build-only",
      "dist/debug.js.map": "source-map-only",
      ".env": "FAKE_PRIVATE_VALUE=do-not-transfer",
      "src/private.ts": "source-only",
      "extensions/remote-runtime/package.json": pluginPackage,
    });
    await writeFiles(packageRoot, {
      "node_modules/native-runtime/package.json": {
        name: "native-runtime",
        version: "1.2.3",
        main: "index.js",
      },
      "node_modules/native-runtime/index.js": "module.exports = 42;",
      "extensions/remote-runtime/node_modules/native-runtime/package.json": {
        name: "native-runtime",
        version: "1.2.3",
        main: "index.js",
      },
      "extensions/remote-runtime/node_modules/native-runtime/index.js": "module.exports = 42;",
    });
    const aiRoot =
      mode === "source"
        ? path.join(root, "ai-source")
        : mode === "linked-package"
          ? path.join(root, "node_modules/linked-project/ai-source")
          : path.join(packageRoot, "node_modules/@fixture/ai");
    await writeFiles(aiRoot, {
      "package.json": { name: "@fixture/ai", version, type: "module", exports: "./dist/index.js" },
      "dist/index.js": 'export const name = "local-ai";',
    });
    if (mode === "source" || mode === "linked-package") {
      await write(aiRoot, ".env", "FAKE_PRIVATE_VALUE=do-not-transfer");
      await write(aiRoot, "src/private.ts", "source-only");
      await fs.mkdir(path.join(packageRoot, "node_modules/@fixture"), { recursive: true });
      await fs.symlink(aiRoot, path.join(packageRoot, "node_modules/@fixture/ai"), "junction");
    }
    let pluginRoot = path.join(
      packageRoot,
      mode === "source" ? "extensions" : "dist/extensions",
      "remote-runtime",
    );
    if (mode === "external-plugin") {
      pluginRoot = path.join(root, "installed-plugin");
      await writeFiles(pluginRoot, {
        "package.json": {
          ...pluginPackage,
          openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] },
        },
        "openclaw.plugin.json": { id: "remote-runtime" },
        "dist/index.js": 'export const answer = "cloud-ready";',
        ".env": "FAKE_PRIVATE_VALUE=do-not-transfer",
        "node_modules/native-runtime/vendor/host-native": "do-not-transfer-native",
      });
      await write(
        packageRoot,
        "dist/entry.js",
        'import { answer } from "./extensions/remote-runtime/dist/index.js"; import { name } from "@fixture/ai"; console.log(`${name}:${answer}`);',
      );
    }
    const options = {
      packageRoot,
      runningBuildId: buildId,
      plugins: [{ id: "remote-runtime", root: pluginRoot }],
    };
    const provider = createProvider(options);
    return { root, packageRoot, pluginRoot, provider, sourcePackage, pluginPackage, options };
  }
  return { fixture, createProvider, tempDirs };
}
