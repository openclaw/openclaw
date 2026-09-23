import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createNodeBootstrapArtifactProvider } from "./node-bootstrap-artifact.js";

export const buildId = "fixture-source-build";
export const version = "2026.8.1";
export const longEntryPath = `dist/${"entry-".repeat(25)}.json`;
export const longEntryPayload = "payload".repeat(90);

export async function write(root: string, relative: string, contents: string | object) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, typeof contents === "string" ? contents : JSON.stringify(contents));
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
  await write(
    browserRoot,
    "build/src/index.js",
    'import { readFileSync } from "node:fs"; export const notice = readFileSync(new URL("./third_party/THIRD_PARTY_NOTICES", import.meta.url), "utf8");',
  );
  await write(
    browserRoot,
    "build/src/bin/browser.js",
    'import { notice } from "../index.js"; console.log(notice);',
  );
  await write(browserRoot, "build/src/third_party/THIRD_PARTY_NOTICES", "bundled-notice");
  await write(browserRoot, "build/src/OPENCLAW_PATCH_NOTICE.md", "patched-runtime");
  await write(browserRoot, "skills/browser/SKILL.md", "browser-skill");
  await write(browserRoot, "LICENSE", "fixture-license");
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
    const provider = createNodeBootstrapArtifactProvider(options);
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
        "dist/",
        "!dist/extensions/remote-runtime/**",
        "scripts/preinstall.mjs",
        "scripts/postinstall.mjs",
      ],
      dependencies: { "@fixture/ai": mode === "source" ? "workspace:*" : version },
      ...(mode !== "source" ? { bundleDependencies: ["@fixture/ai"] } : {}),
      devDependencies: { "typescript-only": "workspace:*" },
      scripts: {
        prepare: "exit 91",
        prepack: "exit 92",
        preinstall: "node scripts/preinstall.mjs",
        postinstall: "node scripts/postinstall.mjs",
      },
    };
    await write(packageRoot, "package.json", sourcePackage);
    await fs.writeFile(path.join(packageRoot, "openclaw.mjs"), 'import "./dist/entry.js";', {
      mode: 0o755,
    });
    await write(packageRoot, "node-version.mjs", "export const supported = true;");
    await write(packageRoot, "node-sqlite.mjs", "export const probe = true;");
    await write(packageRoot, "node-runtime-update.mjs", "export const update = true;");
    await write(packageRoot, "node-runtime-recovery.mjs", "export const recovery = true;");
    await write(packageRoot, "cli-root-options.mjs", "export {};");
    await write(packageRoot, "gateway-run-argv.mjs", "export {};");
    await write(packageRoot, "gateway-shutdown-budget.mjs", "export {};");
    await write(packageRoot, "node-host-launcher.mjs", "export const launcher = true;");
    await write(packageRoot, "scripts/preinstall.mjs", "export {};\n");
    await write(
      packageRoot,
      "scripts/postinstall.mjs",
      'import { rmSync } from "node:fs"; rmSync(new URL("../.openclaw-lifecycle-pending", import.meta.url));',
    );
    await write(
      packageRoot,
      "dist/entry.js",
      'import { answer } from "./extensions/remote-runtime/index.js"; import { name } from "../node_modules/@fixture/ai/dist/index.js"; console.log(`${name}:${answer}`);',
    );
    await write(packageRoot, "dist/control-ui/index.html", "<title>Gateway dashboard</title>");
    await write(packageRoot, "dist/control-ui/assets/app.js", 'console.log("gateway-ui");');
    await write(packageRoot, "dist/shared.js", 'export const answer = "cloud-ready";');
    await write(packageRoot, "dist/empty.js", "");
    await write(packageRoot, longEntryPath, { payload: longEntryPayload });
    await write(packageRoot, "dist/worker/worker.mjs", 'console.log("separate-worker-bundle");');
    await write(packageRoot, "dist/worker/workspace-rsync-receiver.mjs", "export {};");
    await write(packageRoot, "dist/worker/github-exec-launcher.mjs", "export {};");
    await write(packageRoot, "dist/build-info.json", { version, buildId });
    await write(packageRoot, "dist/extensions/remote-runtime/package.json", pluginPackage);
    await write(packageRoot, "dist/extensions/remote-runtime/openclaw.plugin.json", {
      id: "remote-runtime",
    });
    await write(
      packageRoot,
      "dist/extensions/remote-runtime/index.js",
      'export { answer } from "../../shared.js";',
    );
    await write(
      packageRoot,
      "dist/extensions/remote-runtime/node_modules/native-runtime/vendor/host-native",
      "do-not-transfer-native",
    );
    await write(packageRoot, "dist/.buildstamp", "local-build-only");
    await write(packageRoot, "dist/debug.js.map", "source-map-only");
    await write(packageRoot, ".env", "FAKE_PRIVATE_VALUE=do-not-transfer");
    await write(packageRoot, "src/private.ts", "source-only");
    await write(packageRoot, "extensions/remote-runtime/package.json", pluginPackage);
    const aiRoot =
      mode === "source"
        ? path.join(root, "ai-source")
        : mode === "linked-package"
          ? path.join(root, "node_modules/linked-project/ai-source")
          : path.join(packageRoot, "node_modules/@fixture/ai");
    await write(aiRoot, "package.json", {
      name: "@fixture/ai",
      version,
      type: "module",
      exports: "./dist/index.js",
    });
    await write(aiRoot, "dist/index.js", 'export const name = "local-ai";');
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
      await write(pluginRoot, "package.json", {
        ...pluginPackage,
        openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] },
      });
      await write(pluginRoot, "openclaw.plugin.json", { id: "remote-runtime" });
      await write(pluginRoot, "dist/index.js", 'export const answer = "cloud-ready";');
      await write(pluginRoot, ".env", "FAKE_PRIVATE_VALUE=do-not-transfer");
      await write(
        pluginRoot,
        "node_modules/native-runtime/vendor/host-native",
        "do-not-transfer-native",
      );
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
    return { root, packageRoot, provider, sourcePackage, pluginPackage, options };
  }
  return { fixture, createProvider, tempDirs };
}
