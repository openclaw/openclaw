import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
// Plugin npm runtime build tests validate plugin runtime package builds.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPluginNpmRuntime,
  listMissingPluginNpmRuntimeHostExports,
  listPublishablePluginPackageDirs,
  resolvePluginNpmRuntimeBuildPlan,
} from "../scripts/lib/plugin-npm-runtime-build.mts";
import { defineBundledChannelSetupEntry } from "../src/plugin-sdk/channel-entry-contract.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type PluginNpmRuntimeBuildPlan = NonNullable<ReturnType<typeof resolvePluginNpmRuntimeBuildPlan>>;

function expectDistRelativePaths(paths: string[]) {
  expect(paths.every((entry) => entry.startsWith("./dist/"))).toBe(true);
}

function expectPluginNpmRuntimeBuildPlan(
  plan: ReturnType<typeof resolvePluginNpmRuntimeBuildPlan>,
): PluginNpmRuntimeBuildPlan {
  if (!plan) {
    throw new Error("expected plugin npm runtime build plan");
  }
  return plan;
}

describe("plugin npm runtime build planning", () => {
  it("packages declared theme definitions and artwork outside conventional asset paths", () => {
    const packageDir = tempDirs.make("openclaw-plugin-theme-package-");
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "theme-fixture",
        version: "1.0.0",
        openclaw: { extensions: ["./index.ts"] },
      }),
    );
    writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "theme-fixture",
        themes: [
          {
            id: "workshop",
            name: "Workshop",
            description: "Workshop colors",
            source: "palettes/workshop.json",
            hats: { beret: "art/beret.svg" },
            critters: { ferris: { source: "visitors/ferris.svg", crossMs: 9000 } },
          },
        ],
      }),
    );
    const plan = expectPluginNpmRuntimeBuildPlan(
      resolvePluginNpmRuntimeBuildPlan({ repoRoot, packageDir }),
    );
    expect(plan.packageFiles).toEqual(
      expect.arrayContaining([
        "openclaw.plugin.json",
        "palettes/workshop.json",
        "art/beret.svg",
        "visitors/ferris.svg",
      ]),
    );
  });

  it.each([
    "missing-directory",
    "missing-manifest",
    "malformed-manifest",
    "no-extensions",
    "javascript-only",
  ])("reports selected package input without touching output (%s)", async (scenario) => {
    const packageDir = path.join(tempDirs.make("openclaw-plugin-runtime-input-"), "selected");
    const manifestPath = path.join(packageDir, "package.json");
    const outDir = path.join(packageDir, "dist");
    if (scenario !== "missing-directory") {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, "sentinel.js"), "keep\n");
    }
    if (scenario === "malformed-manifest") {
      writeFileSync(manifestPath, "{");
    } else if (scenario === "no-extensions" || scenario === "javascript-only") {
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: "input-fixture",
          version: "1.0.0",
          ...(scenario === "javascript-only" ? { openclaw: { extensions: ["./index.js"] } } : {}),
        }),
      );
      writeFileSync(path.join(packageDir, "index.js"), "export default {};\n");
    }

    const result = buildPluginNpmRuntime({ repoRoot, packageDir, logLevel: "silent" });
    if (scenario === "missing-directory" || scenario === "missing-manifest") {
      await expect(result).rejects.toMatchObject({ code: "ENOENT", path: manifestPath });
    } else if (scenario === "malformed-manifest") {
      await expect(result).rejects.toBeInstanceOf(SyntaxError);
    } else {
      await expect(result).resolves.toBeNull();
    }
    if (scenario === "missing-directory") {
      expect(existsSync(packageDir)).toBe(false);
    } else {
      expect(readdirSync(outDir)).toEqual(["sentinel.js"]);
      expect(readFileSync(path.join(outDir, "sentinel.js"), "utf8")).toBe("keep\n");
    }
  });

  it.each(["qa-lab", "qa-channel"])(
    "builds an executable %s Gateway fixture without the tooling graph",
    async (id) => {
      const packageDir = path.join(tempDirs.make("openclaw-qa-gateway-package-"), id);
      mkdirSync(packageDir);
      writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: `@openclaw/${id}`,
          private: true,
          version: "2026.9.5",
          type: "module",
          dependencies: id === "qa-channel" ? { typebox: "1.3.32", zod: "4.6.5" } : {},
          openclaw: {
            extensions: ["./index.ts"],
            build: { workerEntries: ["./tooling.worker.ts"] },
          },
        }),
      );
      writeFileSync(path.join(packageDir, "openclaw.plugin.json"), JSON.stringify({ id }));
      for (const file of ["tooling-api.ts", "tooling.worker.ts"]) {
        writeFileSync(path.join(packageDir, file), 'import "private-qa-tooling-not-installed";\n');
      }
      const protocol = 'export { parseQaTarget } from "openclaw/plugin-sdk/qa-channel-protocol";\n';
      if (id === "qa-lab") {
        writeFileSync(
          path.join(packageDir, "index.ts"),
          'import "private-qa-tooling-not-installed";\n',
        );
        writeFileSync(path.join(packageDir, "gateway-entry.ts"), protocol);
      } else {
        writeFileSync(path.join(packageDir, "index.ts"), 'export const companion = "./api.js";\n');
        writeFileSync(path.join(packageDir, "api.ts"), protocol);
        for (const file of ["setup-entry.ts", "setup-plugin-api.ts", "channel-plugin-api.ts"]) {
          writeFileSync(path.join(packageDir, file), 'export const id = "qa-channel";\n');
        }
      }

      const plan = expectPluginNpmRuntimeBuildPlan(
        await buildPluginNpmRuntime({
          repoRoot,
          packageDir,
          profile: "qa-gateway-fixture",
          logLevel: "silent",
        }),
      );
      const runtimeEntry = expectDefined(
        plan.runtimeExtensions[0],
        "QA Gateway fixture runtime entry",
      );
      const entryUrl = pathToFileURL(path.join(packageDir, runtimeEntry));
      const entry = await import(entryUrl.href);
      const runtime =
        id === "qa-channel" ? await import(new URL(entry.companion, entryUrl).href) : entry;
      expect(runtime.parseQaTarget("thread:/v1/dm/Case%2FID/Thread")).toEqual({
        chatType: "direct",
        conversationId: "Case/ID",
        threadId: "Thread",
      });
      expect(listMissingPluginNpmRuntimeHostExports(plan)).toEqual([]);
    },
  );

  it("builds a private worker without registering it as a plugin entry", async () => {
    const packageDir = tempDirs.make("openclaw-plugin-runtime-worker-");
    mkdirSync(path.join(packageDir, "src"));
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/worker-fixture",
        version: "1.0.0",
        type: "module",
        openclaw: {
          extensions: ["./index.ts"],
          compat: { pluginApi: "1.0.0" },
          build: { workerEntries: ["./src/store.worker.ts"] },
        },
      }),
    );
    writeFileSync(
      path.join(packageDir, "index.ts"),
      `import { resolveRuntimeWorkerUrl } from ${JSON.stringify(path.join(repoRoot, "src/infra/runtime-worker-url.ts").replaceAll("\\", "/"))};
` +
        `export const workerUrl = resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "store.worker",
          distWorkerPath: "extensions/worker-fixture/src/store.worker.js",
          package: { name: "@openclaw/worker-fixture", distWorkerPath: "src/store.worker.js" },
        });
`,
    );
    writeFileSync(
      path.join(packageDir, "src/store.worker.ts"),
      'import { parentPort, isMainThread } from "node:worker_threads";\n' +
        "const value: number = 42; parentPort!.postMessage({ value, isMainThread });\n",
    );

    const plan = expectPluginNpmRuntimeBuildPlan(
      await buildPluginNpmRuntime({ repoRoot, packageDir, logLevel: "silent" }),
    );
    expect(plan.runtimeExtensions).toEqual(["./dist/index.js"]);
    const { workerUrl } = await import(pathToFileURL(path.join(packageDir, "dist/index.js")).href);
    const worker = new Worker(workerUrl);
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`Worker exited before replying: ${code}`)));
      });
      expect(result).toEqual({ value: 42, isMainThread: false });
    } finally {
      await worker.terminate();
    }
  });

  it.each(["index.tsx", "src/index.tsx"])(
    "builds an executable %s package entry",
    async (entry) => {
      const packageDir = tempDirs.make("openclaw-plugin-runtime-tsx-");
      mkdirSync(path.dirname(path.join(packageDir, entry)), { recursive: true });
      writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "@openclaw/tsx-fixture",
          version: "1.0.0",
          type: "module",
          openclaw: { extensions: [`./${entry}`], compat: { pluginApi: "1.0.0" } },
        }),
      );
      writeFileSync(
        path.join(packageDir, entry),
        'const id: string = "tsx-fixture"; export default { id };\n',
      );

      await buildPluginNpmRuntime({ repoRoot, packageDir, logLevel: "silent" });

      const outputPath = path.join(packageDir, "dist", entry.replace(/\.tsx$/u, ".js"));
      expect(existsSync(outputPath)).toBe(true);
      expect((await import(pathToFileURL(outputPath).href)).default.id).toBe("tsx-fixture");
    },
  );

  it("rejects a symlinked package dist root before building", async () => {
    const syntheticRepoRoot = tempDirs.make("openclaw-plugin-runtime-output-root-");
    const packageDir = path.join(syntheticRepoRoot, "extensions", "demo");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(syntheticRepoRoot, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/demo",
        version: "1.0.0",
        openclaw: {
          compat: { pluginApi: "1.0.0" },
          extensions: ["./index.ts"],
          release: { publishToNpm: true },
        },
      }),
    );
    writeFileSync(path.join(packageDir, "index.ts"), "export default {};\n");
    const targetDir = path.join(syntheticRepoRoot, "live-gateway-dist");
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, "sentinel.js"), "keep\n");
    symlinkSync(targetDir, path.join(packageDir, "dist"), "dir");

    await expect(
      buildPluginNpmRuntime({
        repoRoot: syntheticRepoRoot,
        packageDir,
        logLevel: "silent",
      }),
    ).rejects.toThrow(/symbolic link/u);
    expect(readFileSync(path.join(targetDir, "sentinel.js"), "utf8")).toBe("keep\n");
    expect(readlinkSync(path.join(packageDir, "dist"))).toBe(targetDir);
  });

  it("plans package-local runtime entries for every publishable plugin package", () => {
    const packageDirs = listPublishablePluginPackageDirs({ repoRoot });
    expect(packageDirs.length).toBeGreaterThan(0);

    const plans = packageDirs.map((packageDir) =>
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir,
      }),
    );
    const resolvedPlans = plans.map(expectPluginNpmRuntimeBuildPlan);
    expect(resolvedPlans.map((plan) => plan.pluginDir)).toEqual(
      packageDirs.map((packageDir) => path.basename(packageDir)),
    );
    for (const plan of resolvedPlans) {
      expect(plan.outDir).toBe(path.join(plan.packageDir, "dist"));
      expectDistRelativePaths(plan.runtimeExtensions);
      expectDistRelativePaths(plan.runtimeBuildOutputs);
      expect(plan.packageFiles).toContain("dist/**");
      if (existsSync(path.join(plan.packageDir, "assets", "activity.svg"))) {
        expect(plan.packageFiles).toContain("assets/activity.svg");
      }
      if (existsSync(path.join(plan.packageDir, "assets", "activity"))) {
        expect(plan.packageFiles).toContain("assets/activity/*.svg");
      }
      expect(plan.packagePeerMetadata.peerDependencies.openclaw).toBe(
        plan.packageJson.openclaw?.compat?.pluginApi,
      );
      expect(plan.packagePeerMetadata.peerDependenciesMeta.openclaw.optional).toBe(true);
    }
  });

  it("includes top-level public runtime surfaces", () => {
    const diffsPlan = resolvePluginNpmRuntimeBuildPlan({
      repoRoot,
      packageDir: path.join(repoRoot, "extensions", "diffs"),
    });
    const diffsRuntimePlan = expectPluginNpmRuntimeBuildPlan(diffsPlan);
    expect(diffsRuntimePlan.entry).toEqual({
      api: path.join(repoRoot, "extensions", "diffs", "api.ts"),
      index: path.join(repoRoot, "extensions", "diffs", "index.ts"),
      "runtime-api": path.join(repoRoot, "extensions", "diffs", "runtime-api.ts"),
    });
    expect(diffsRuntimePlan.packageFiles).toEqual([
      "dist/**",
      "openclaw.plugin.json",
      "README.md",
      "assets/icon.png",
      "assets/activity.svg",
      "skills/**",
    ]);
  });

  it("builds doctor contract surfaces for publishable channel plugins", () => {
    for (const pluginDir of ["msteams", "nostr"]) {
      const plan = expectPluginNpmRuntimeBuildPlan(
        resolvePluginNpmRuntimeBuildPlan({
          repoRoot,
          packageDir: path.join(repoRoot, "extensions", pluginDir),
        }),
      );
      expect(plan.entry["doctor-contract-api"]).toBe(
        path.join(repoRoot, "extensions", pluginDir, "doctor-contract-api.ts"),
      );
      const extension = plan.runtimeFormat === "cjs" ? ".cjs" : ".js";
      expect(plan.runtimeBuildOutputs).toContain(`./dist/doctor-contract-api${extension}`);
      expect(plan.packageFiles).toContain("dist/**");
    }
  });

  it("builds msteams startup runtime surfaces as CommonJS files", async () => {
    const result = await buildPluginNpmRuntime({
      repoRoot,
      packageDir: "extensions/msteams",
      logLevel: "silent",
    });
    const plan = expectPluginNpmRuntimeBuildPlan(result);

    expect(plan.runtimeFormat).toBe("cjs");
    expect(plan.runtimeExtensions).toEqual(["./dist/index.cjs"]);
    expect(plan.runtimeSetupEntry).toBe("./dist/setup-entry.cjs");

    const entrypoints = [
      "dist/index.cjs",
      "dist/channel-plugin-api.cjs",
      "dist/runtime-api.cjs",
      "dist/setup-plugin-api.cjs",
      "dist/secret-contract-api.cjs",
    ];
    const missing = entrypoints.filter(
      (relativePath) => !existsSync(path.join(repoRoot, "extensions/msteams", relativePath)),
    );
    expect(missing).toEqual([]);

    for (const relativePath of entrypoints) {
      const text = readFileSync(path.join(repoRoot, "extensions/msteams", relativePath), "utf8");
      expect(text).not.toMatch(/^import\s/u);
      expect(text).toMatch(/(?:require\(|exports\.)/u);
    }

    const indexText = readFileSync(
      path.join(repoRoot, "extensions/msteams/dist/index.cjs"),
      "utf8",
    );
    expect(indexText).toContain('specifier: "./channel-plugin-api.cjs"');
    expect(indexText).toContain('specifier: "./secret-contract-api.cjs"');
    expect(indexText).toContain('specifier: "./runtime-api.cjs"');

    const setupEntryPath = path.join(plan.outDir, "setup-entry.cjs");
    const defineSetupEntry = vi.fn(defineBundledChannelSetupEntry);
    const setupModule: { exports: Partial<ReturnType<typeof defineBundledChannelSetupEntry>> } = {
      exports: {},
    };
    const require = createRequire(import.meta.url);
    // Execute the emitted URL expressions and load companions through the host SDK;
    // hashed inventory chunks are private, while the setup entry remains stable.
    runInNewContext(readFileSync(setupEntryPath, "utf8"), {
      __filename: setupEntryPath,
      __dirname: plan.outDir,
      module: setupModule,
      exports: setupModule.exports,
      URL,
      require: (specifier: string) =>
        specifier === "openclaw/plugin-sdk/channel-entry-contract"
          ? { defineBundledChannelSetupEntry: defineSetupEntry }
          : require(specifier),
    });
    expect(defineSetupEntry).toHaveBeenCalledOnce();
    const options = defineSetupEntry.mock.calls[0]?.[0];
    for (const reference of [options?.plugin, options?.secrets]) {
      if (!reference) {
        throw new Error("Missing setup companion reference");
      }
      expect(path.dirname(reference.specifier)).toBe(path.join(plan.outDir, ".setup"));
      expect(path.extname(reference.specifier)).toBe(".cjs");
      expect(existsSync(reference.specifier)).toBe(true);
    }
    expect(setupModule.exports).toBe(defineSetupEntry.mock.results[0]?.value);
    expect(setupModule.exports.kind).toBe("bundled-channel-setup-entry");
    expect(setupModule.exports.loadSetupPlugin?.()).toMatchObject({ id: "msteams" });
    expect(setupModule.exports.loadSetupSecrets?.()).toMatchObject({
      collectRuntimeConfigAssignments: expect.any(Function),
      secretTargetRegistryEntries: expect.any(Array),
    });
  });

  it("builds Tencent setup metadata for installed-package migrations", () => {
    const plan = expectPluginNpmRuntimeBuildPlan(
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir: path.join(repoRoot, "extensions", "tencent"),
      }),
    );

    expect(plan.entry["setup-api"]).toBe(
      path.join(repoRoot, "extensions", "tencent", "setup-api.ts"),
    );
    expect(plan.runtimeSetupEntry).toBe("./dist/setup-api.js");
    expect(plan.runtimeBuildOutputs).toContain("./dist/setup-api.js");
  });

  it("plans the Zalo public setup API with its lazy package surface", () => {
    const packageDir = path.join(repoRoot, "extensions", "zalo");
    const plan = expectPluginNpmRuntimeBuildPlan(
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir,
      }),
    );
    expect(plan.entry["setup-api"]).toBe(path.join(packageDir, "setup-api.ts"));
    expect(plan.entry["setup-surface"]).toBe(path.join(packageDir, "setup-surface.ts"));
    expect(plan.runtimeBuildOutputs).toContain("./dist/setup-api.js");
    expect(plan.runtimeBuildOutputs).toContain("./dist/setup-surface.js");
    expect(plan.runtimeBuildOutputs).not.toContain("./dist/src/setup-surface.js");
    expect(plan.packageFiles).toContain("dist/**");
  });

  it("keeps published Codex runtime imports resolvable from the host package", async () => {
    const result = await buildPluginNpmRuntime({
      repoRoot,
      packageDir: "extensions/codex",
      logLevel: "silent",
    });
    const plan = expectPluginNpmRuntimeBuildPlan(result);

    expect(listMissingPluginNpmRuntimeHostExports(plan)).toEqual([]);
  });

  it("keeps published llama.cpp runtime imports resolvable from the host package", async () => {
    const result = await buildPluginNpmRuntime({
      repoRoot,
      packageDir: "extensions/llama-cpp",
      logLevel: "silent",
    });
    const plan = expectPluginNpmRuntimeBuildPlan(result);

    expect(listMissingPluginNpmRuntimeHostExports(plan)).toEqual([]);
  });

  it("detects unresolved side-effect host imports in built plugin runtimes", () => {
    const outDir = tempDirs.make("openclaw-plugin-runtime-host-import-");
    writeFileSync(
      path.join(outDir, "index.js"),
      [
        'import "openclaw/plugin-sdk/not-exported";',
        'const runtime = __require("openclaw/plugin-sdk/not-exported-from-require");',
        "void runtime;",
        "",
      ].join("\n"),
    );
    const plan = expectPluginNpmRuntimeBuildPlan(
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir: path.join(repoRoot, "extensions", "codex"),
      }),
    );

    expect(listMissingPluginNpmRuntimeHostExports({ ...plan, outDir })).toEqual([
      "openclaw/plugin-sdk/not-exported",
      "openclaw/plugin-sdk/not-exported-from-require",
    ]);
  });

  it("does not require host metadata when the runtime has no host imports", () => {
    const syntheticRepoRoot = tempDirs.make("openclaw-plugin-runtime-synthetic-repo-");
    const outDir = tempDirs.make("openclaw-plugin-runtime-no-host-import-");
    writeFileSync(path.join(outDir, "index.js"), "export default {};\n");
    const plan = expectPluginNpmRuntimeBuildPlan(
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir: path.join(repoRoot, "extensions", "codex"),
      }),
    );

    expect(
      listMissingPluginNpmRuntimeHostExports({ ...plan, repoRoot: syntheticRepoRoot, outDir }),
    ).toEqual([]);
  });
});
