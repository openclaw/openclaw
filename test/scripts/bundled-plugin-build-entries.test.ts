import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectRetainedDoctorBuildEntries,
  collectPluginDeclarationSourceEntries,
  collectRootPackageExcludedExtensionDirs,
  collectSourceCheckoutPluginBuildEntries,
  collectBundledPluginBuildEntries,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
  listBundledPluginPackArtifacts,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { resolvePluginNpmRuntimeBuildPlan } from "../../scripts/lib/plugin-npm-runtime-build.mts";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function write(root: string, name: string, contents: unknown = "export {};\n") {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents));
}

function excludedPluginFixture(prefix: string) {
  const cwd = tempDirs.make(prefix);
  write(cwd, "package.json", { files: ["dist/**", "!dist/extensions/external-owner/**"] });
  return {
    cwd,
    writePlugin: (name: string, contents: unknown) =>
      write(cwd, `extensions/external-owner/${name}`, contents),
  };
}

function collectBuildSources(params?: Parameters<typeof collectBundledPluginBuildEntries>[0]) {
  return collectBundledPluginBuildEntries(params).flatMap(({ id, sourceEntries }) =>
    sourceEntries.map((entry) => path.posix.join("extensions", id, entry)),
  );
}

describe("bundled plugin build entries", () => {
  it("preserves tracked entry names and ignores deleted or untracked plugin inputs", () => {
    const cwd = tempDirs.make("openclaw-tracked-plugin-entries-");
    const writeFile = (name: string, contents?: unknown) => write(cwd, name, contents);
    writeFile("package.json", { name: "openclaw", files: ["dist/**"] });
    const names = [
      " leading-space.ts",
      "café.ts",
      "index.ts",
      ...(process.platform === "win32" ? [] : ["line\nbreak.ts", "literal\\backslash.ts"]),
    ];
    writeFile("extensions/demo/openclaw.plugin.json", { id: "demo" });
    writeFile("extensions/demo/package.json", {
      name: "@openclaw/demo",
      openclaw: { extensions: ["./index.ts"] },
    });
    for (const name of [...names, "deleted.ts", "probe.test.ts", "types.d.ts"]) {
      writeFile(`extensions/demo/${name}`);
    }
    writeFile("extensions/demo/src/private.ts");
    writeFile("extensions/nested-only/src/private.ts");
    writeFile("extensions/gone/src/deleted.ts");
    writeFile(
      "extensions/deleted-metadata/openclaw.plugin.json",
      JSON.stringify({ id: "deleted-metadata" }),
    );
    writeFile("extensions/deleted-metadata/index.ts");
    execFileSync("git", ["init", "--quiet", cwd]);
    execFileSync("git", ["-C", cwd, "add", "--", "extensions"]);
    for (const name of [
      "extensions/demo/deleted.ts",
      "extensions/gone/src/deleted.ts",
      "extensions/deleted-metadata/openclaw.plugin.json",
    ]) {
      fs.unlinkSync(path.join(cwd, name));
    }
    writeFile("extensions/demo/untracked.ts");
    writeFile("extensions/untracked/openclaw.plugin.json", { id: "untracked" });
    writeFile("extensions/untracked/index.ts");

    const params = { cwd, env: { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "nested-only" } };
    const entries = collectSourceCheckoutPluginBuildEntries(params);
    const expectedSources = [
      "./index.ts",
      ...names
        .filter((name) => name !== "index.ts")
        .toSorted((a, b) => a.localeCompare(b))
        .map((name) => `./${name}`),
    ];
    expect(entries.map(({ id }) => id)).toEqual(["demo"]);
    expect(entries[0]?.sourceEntries).toEqual(expectedSources);
    expect(collectBuildSources(params)).toEqual(
      expectedSources.map((name) => `extensions/demo/${name.slice(2)}`),
    );
    expect(() =>
      collectSourceCheckoutPluginBuildEntries({
        cwd,
        env: { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "gone" },
      }),
    ).toThrow("unknown plugin id(s): gone");
  });

  it("selects typed barrels and manifest exports rather than every runtime sidecar", () => {
    const sources = [
      "./index.ts",
      "./api.ts",
      "./runtime-api.ts",
      "./contract-api.ts",
      "./client.ts",
      "./types.ts",
      "./runtime-helper.ts",
      "./setup-entry.ts",
    ];
    expect(
      collectPluginDeclarationSourceEntries(
        {
          exports: { "./client": { types: "./dist/client.d.ts", import: "./dist/client.js" } },
          types: "./dist/types.d.ts",
        },
        sources,
      ),
    ).toEqual(["./api.ts", "./runtime-api.ts", "./contract-api.ts", "./client.ts", "./types.ts"]);
  });

  it("retains manifest-owned config repairs independently of runtime package exclusions", () => {
    const { cwd, writePlugin } = excludedPluginFixture("openclaw-config-doctor-entries-");
    writePlugin("package.json", {
      name: "@openclaw/external-owner",
      openclaw: { build: { bundledDist: false } },
    });
    const manifest = {
      id: "external-owner",
      channels: ["renamed-channel"],
      doctorContract: { configRepair: true, stateMigrations: true },
    };
    writePlugin("openclaw.plugin.json", manifest);
    expect(() => collectRetainedDoctorBuildEntries({ cwd })).toThrow(
      /Missing config-only doctor entrypoint/,
    );
    writePlugin("config-doctor-api.ts", "export const legacyConfigRules = [];\n");
    expect(collectRetainedDoctorBuildEntries({ cwd })).toEqual({
      "renamed-channel": "extensions/external-owner/config-doctor-api.ts",
    });
    writePlugin("openclaw.plugin.json", { ...manifest, doctorContract: { stateMigrations: true } });
    expect(collectRetainedDoctorBuildEntries({ cwd })).toEqual({});
  });

  it("retains non-channel state checks under plugin IDs while excluding plugin runtimes", () => {
    const { cwd, writePlugin } = excludedPluginFixture("openclaw-state-retention-entries-");
    writePlugin("openclaw.plugin.json", {
      id: "external-owner",
      doctorContract: { stateMigrations: [{ id: "retired-log" }] },
    });
    writePlugin("state-retention-api.ts", "export const stateMigrations = [];\n");
    expect(collectRetainedDoctorBuildEntries({ cwd, surface: "state-retention" })).toEqual({
      "external-owner": "extensions/external-owner/state-retention-api.ts",
    });
    expect(collectRetainedDoctorBuildEntries({ cwd })).toEqual({});
    expect(listBundledPluginPackArtifacts({ cwd })).toEqual([]);
  });

  function* bundledChannelEntries() {
    for (const dirent of fs.readdirSync("extensions", { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }
      for (const sourceEntry of ["index.ts", "channel-entry.ts", "setup-entry.ts"]) {
        const entryPath = path.join("extensions", dirent.name, sourceEntry);
        if (fs.existsSync(entryPath)) {
          yield { entryPath, entry: fs.readFileSync(entryPath, "utf8"), pluginId: dirent.name };
        }
      }
    }
  }

  it("includes the manifest-less runtime core support package in dist build entries", () => {
    expect(collectBuildSources()).toContain("extensions/image-generation-core/runtime-api.ts");
  });

  it("packs the runtime core support package without requiring a plugin manifest", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).toContain("dist/extensions/image-generation-core/package.json");
    expect(artifacts).toContain("dist/extensions/image-generation-core/runtime-api.js");
    expect(artifacts).not.toContain("dist/extensions/image-generation-core/openclaw.plugin.json");
  });

  it.each([["discord", "src/voice/audio-worker.runtime", true]] as const)(
    "emits %s/%s through its owning build",
    (id, worker, isolated) => {
      const entry = collectSourceCheckoutPluginBuildEntries().find((plugin) => plugin.id === id);
      const plan = resolvePluginNpmRuntimeBuildPlan({ packageDir: `extensions/${id}` });
      const artifacts = listBundledPluginPackArtifacts();

      expect(entry?.isolated).toBe(isolated);
      expect(entry?.sourceEntries).toContain(`./${worker}.ts`);
      expect(plan?.entry[worker]).toBe(path.resolve(`extensions/${id}/${worker}.ts`));
      expect(plan?.runtimeBuildOutputs).toContain(`./dist/${worker}.js`);
      expect(plan?.runtimeExtensions).not.toContain(`./dist/${worker}.js`);
      expect(artifacts.includes(`dist/extensions/${id}/${worker}.js`)).toBe(!isolated);
    },
  );

  it("keeps the Matrix packaged runtime shim in its package-owned build", () => {
    const entryKeys = collectBuildSources().map((source) => source.replace(/\.[^.]+$/u, ""));
    const plan = resolvePluginNpmRuntimeBuildPlan({ packageDir: "extensions/matrix" });
    expect(entryKeys).not.toContain("extensions/matrix/plugin-entry.handlers.runtime");
    expect(plan?.entry["plugin-entry.handlers.runtime"]).toBe(
      path.resolve("extensions/matrix/plugin-entry.handlers.runtime.ts"),
    );
    expect(plan?.runtimeBuildOutputs).toContain("./dist/plugin-entry.handlers.runtime.js");
  });

  it("keeps Codex CLI metadata in bundled build and standalone pack entries", () => {
    const sources = collectBuildSources();
    const artifacts = listBundledPluginPackArtifacts({ includeRootPackageExcludedDirs: true });
    const sourceEntry = collectSourceCheckoutPluginBuildEntries().find(({ id }) => id === "codex");

    expect(sources).toContain("extensions/codex/cli-metadata.ts");
    expect(artifacts).toContain("dist/extensions/codex/cli-metadata.js");
    expect(sourceEntry).toMatchObject({ isolated: true, runtimeExtension: ".js" });
  });

  it("rejects unknown bounded bundled plugin build ids", () => {
    expect(() =>
      collectBundledPluginBuildEntries({
        env: {
          ...process.env,
          OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "missing-plugin",
        },
      }),
    ).toThrow(
      "OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS references unknown bundled plugin id(s): missing-plugin",
    );
  });

  it("keeps the Telegram ingress worker out of bundled plugin public-surface entries", () => {
    const entryKeys = collectBuildSources().map((source) => source.replace(/\.[^.]+$/u, ""));
    expect(entryKeys).not.toContain("extensions/telegram/telegram-ingress-worker.runtime");
  });

  it("keeps top-level bundled plugin test helpers out of public-surface entries", () => {
    const entryKeys = collectBuildSources().map((source) => source.replace(/\.[^.]+$/u, ""));
    for (const entry of [
      "browser/test-support",
      "comfy/test-helpers",
      "minimax/provider-http.test-helpers",
    ]) {
      expect(entryKeys).not.toContain(`extensions/${entry}`);
    }
  });

  it("discovers repo plugin build entries without directory scans", () => {
    const payload = expectNoNodeFsScans<{
      artifacts: number;
      entries: number;
    }>(
      `
        const build = await import("./scripts/lib/bundled-plugin-build-entries.mjs");
        const entries = build.collectBundledPluginBuildEntries();
        const artifacts = build.listBundledPluginPackArtifacts();
        return {
          artifacts: artifacts.length,
          entries: entries.reduce((count, entry) => count + entry.sourceEntries.length, 0),
        };
      `,
      { counters: ["readdirSync"] },
    );

    expect(payload.entries).toBeGreaterThan(0);
    expect(payload.artifacts).toBeGreaterThan(0);
  });

  it("builds explicitly selected external plugins only for Docker", () => {
    const baselineEnv = { ...process.env };
    delete baselineEnv[DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV];
    const dockerEnv = {
      ...baselineEnv,
      [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack clickclack,slack,msteams,whatsapp",
    };
    const sources = collectBuildSources({ env: dockerEnv });
    const baselineArtifacts = listBundledPluginPackArtifacts({ env: baselineEnv });
    const artifacts = listBundledPluginPackArtifacts({ env: dockerEnv });
    const reorderedSources = collectBuildSources({
      env: {
        ...baselineEnv,
        [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "whatsapp,msteams,clickclack slack",
      },
    });
    expect(sources).toContain("extensions/clickclack/index.ts");
    expect(sources).toContain("extensions/slack/index.ts");
    expect(sources).toContain("extensions/slack/setup-entry.ts");
    expect(sources).toContain("extensions/msteams/index.ts");
    expect(sources).toContain("extensions/whatsapp/index.ts");
    expect(sources).toContain("extensions/whatsapp/setup-entry.ts");
    expect(sources).toContain("extensions/clawrouter/index.ts");
    expect(sources.findIndex((entry) => entry.startsWith("extensions/clickclack/"))).toBeLessThan(
      sources.findIndex((entry) => entry.startsWith("extensions/slack/")),
    );
    expect(reorderedSources).toEqual(sources);
    expect(artifacts).toEqual(baselineArtifacts);
    for (const id of ["clickclack", "msteams", "slack", "whatsapp"]) {
      expect(artifacts.filter((entry) => entry.startsWith(`dist/extensions/${id}/`))).toEqual([]);
    }
  });

  it("sorts Docker-selected build entries without git metadata", () => {
    const repoDir = tempDirs.make("openclaw-docker-build-entries-");
    const extensionsDir = path.join(repoDir, "extensions");

    for (const pluginId of ["clickclack", "msteams", "slack"]) {
      write(repoDir, `extensions/${pluginId}/index.ts`, "export default {};\n");
      write(repoDir, `extensions/${pluginId}/openclaw.plugin.json`, { id: pluginId });
      write(repoDir, `extensions/${pluginId}/package.json`, {
        name: `@openclaw/${pluginId}`,
        openclaw: { extensions: ["./index.ts"], build: { bundledDist: false } },
      });
    }

    const unsortedDirents = fs.readdirSync(extensionsDir, { withFileTypes: true }).toReversed();
    const readdirSpy = vi
      .spyOn(fs, "readdirSync")
      .mockImplementationOnce(() => unsortedDirents as never);
    try {
      expect(
        collectBuildSources({
          cwd: repoDir,
          env: {
            ...process.env,
            [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack,msteams,clickclack",
          },
        }),
      ).toEqual([
        "extensions/clickclack/index.ts",
        "extensions/msteams/index.ts",
        "extensions/slack/index.ts",
      ]);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("rejects unknown and invalid Docker plugin selections", () => {
    for (const [selection, message] of [
      [
        "missing-plugin",
        `${DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV} references unknown plugin id(s): missing-plugin`,
      ],
      [
        "../clickclack",
        `${DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV} contains invalid plugin id(s): ../clickclack`,
      ],
    ] as const) {
      expect(() =>
        collectBundledPluginBuildEntries({
          env: {
            ...process.env,
            [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: selection,
          },
        }),
      ).toThrow(message);
    }
  });

  it("ships Requesty provider runtime and metadata in the core package", () => {
    expect(listBundledPluginPackArtifacts()).toEqual(
      expect.arrayContaining([
        "dist/extensions/requesty/index.js",
        "dist/extensions/requesty/api.js",
        "dist/extensions/requesty/provider-policy-api.js",
        "dist/extensions/requesty/openclaw.plugin.json",
        "dist/extensions/requesty/package.json",
      ]),
    );
  });

  it("keeps OpenCode Go bundled until its companion artifact is available", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).toEqual(
      expect.arrayContaining([
        "dist/extensions/opencode-go/index.js",
        "dist/extensions/opencode-go/openclaw.plugin.json",
        "dist/extensions/opencode-go/package.json",
      ]),
    );
  });

  it("keeps bundled channel secret contracts on packed top-level sidecars", () => {
    const artifacts = listBundledPluginPackArtifacts();
    const excludedPackageDirs = collectRootPackageExcludedExtensionDirs();
    const secretBackedPluginIds = new Set<string>();
    for (const { entryPath, entry, pluginId } of bundledChannelEntries()) {
      if (!entry.includes('exportName: "channelSecrets"')) {
        continue;
      }
      secretBackedPluginIds.add(pluginId);
      expect(entry, entryPath).not.toContain("./src/secret-contract.js");
      expect(entry).toContain('specifier: "./secret-contract-api.js"');
    }

    for (const pluginId of [...secretBackedPluginIds].toSorted()) {
      if (excludedPackageDirs.has(pluginId)) {
        continue;
      }
      const secretApiPath = path.join("extensions", pluginId, "secret-contract-api.ts");
      expect(fs.readFileSync(secretApiPath, "utf8")).toContain("channelSecrets");
      expect(artifacts).toContain(`dist/extensions/${pluginId}/secret-contract-api.js`);
    }
  });
});
