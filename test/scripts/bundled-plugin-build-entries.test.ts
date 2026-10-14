// Bundled Plugin Build Entries tests cover bundled plugin build entries script behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function collectBuildSources(params?: Parameters<typeof collectBundledPluginBuildEntries>[0]) {
  return collectBundledPluginBuildEntries(params).flatMap(({ id, sourceEntries }) =>
    sourceEntries.map((entry) => path.posix.join("extensions", id, entry)),
  );
}

describe("bundled plugin build entries", () => {
  it("preserves tracked entry names and ignores deleted or untracked plugin inputs", () => {
    const cwd = tempDirs.make("openclaw-tracked-plugin-entries-");
    const write = (name: string, contents = "export {};\n") => {
      const target = path.join(cwd, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    };
    write("package.json", JSON.stringify({ name: "openclaw", files: ["dist/**"] }));
    const names = [
      " leading-space.ts",
      "café.ts",
      "index.ts",
      ...(process.platform === "win32" ? [] : ["line\nbreak.ts", "literal\\backslash.ts"]),
    ];
    write("extensions/demo/openclaw.plugin.json", JSON.stringify({ id: "demo" }));
    write(
      "extensions/demo/package.json",
      JSON.stringify({ name: "@openclaw/demo", openclaw: { extensions: ["./index.ts"] } }),
    );
    for (const name of [...names, "deleted.ts", "probe.test.ts", "types.d.ts"]) {
      write(`extensions/demo/${name}`);
    }
    write("extensions/demo/src/private.ts");
    write("extensions/nested-only/src/private.ts");
    write("extensions/gone/src/deleted.ts");
    write(
      "extensions/deleted-metadata/openclaw.plugin.json",
      JSON.stringify({ id: "deleted-metadata" }),
    );
    write("extensions/deleted-metadata/index.ts");
    execFileSync("git", ["init", "--quiet", cwd]);
    execFileSync("git", ["-C", cwd, "add", "--", "extensions"]);
    for (const name of [
      "extensions/demo/deleted.ts",
      "extensions/gone/src/deleted.ts",
      "extensions/deleted-metadata/openclaw.plugin.json",
    ]) {
      fs.unlinkSync(path.join(cwd, name));
    }
    write("extensions/demo/untracked.ts");
    write("extensions/untracked/openclaw.plugin.json", JSON.stringify({ id: "untracked" }));
    write("extensions/untracked/index.ts");

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
    const cwd = tempDirs.make("openclaw-config-doctor-entries-");
    const pluginDir = path.join(cwd, "extensions", "external-owner");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        files: ["dist/**", "!dist/extensions/external-owner/**"],
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/external-owner",
        openclaw: { build: { bundledDist: false } },
      }),
    );
    const manifest = {
      id: "external-owner",
      channels: ["renamed-channel"],
      doctorContract: { configRepair: true, stateMigrations: true },
    };
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => collectRetainedDoctorBuildEntries({ cwd })).toThrow(
      /Missing config-only doctor entrypoint/,
    );
    fs.writeFileSync(
      path.join(pluginDir, "config-doctor-api.ts"),
      "export const legacyConfigRules = [];\n",
    );
    expect(collectRetainedDoctorBuildEntries({ cwd })).toEqual({
      "renamed-channel": "extensions/external-owner/config-doctor-api.ts",
    });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, doctorContract: { stateMigrations: true } }),
    );
    expect(collectRetainedDoctorBuildEntries({ cwd })).toEqual({});
  });

  it("retains non-channel state checks under plugin IDs while excluding plugin runtimes", () => {
    const cwd = tempDirs.make("openclaw-state-retention-entries-");
    const pluginDir = path.join(cwd, "extensions", "external-owner");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        files: ["dist/**", "!dist/extensions/external-owner/**"],
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "external-owner",
        doctorContract: { stateMigrations: [{ id: "retired-log" }] },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "state-retention-api.ts"),
      "export const stateMigrations = [];\n",
    );
    expect(collectRetainedDoctorBuildEntries({ cwd, surface: "state-retention" })).toEqual({
      "external-owner": "extensions/external-owner/state-retention-api.ts",
    });
    expect(collectRetainedDoctorBuildEntries({ cwd })).toEqual({});
    expect(listBundledPluginPackArtifacts({ cwd })).toEqual([]);
  });

  const bundledChannelEntrySources = ["index.ts", "channel-entry.ts", "setup-entry.ts"];
  const forEachBundledChannelEntry = (
    visit: (params: { entryPath: string; entry: string; pluginId: string }) => void,
  ) => {
    for (const dirent of fs.readdirSync("extensions", { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }

      for (const sourceEntry of bundledChannelEntrySources) {
        const entryPath = path.join("extensions", dirent.name, sourceEntry);
        if (!fs.existsSync(entryPath)) {
          continue;
        }
        visit({
          entryPath,
          entry: fs.readFileSync(entryPath, "utf8"),
          pluginId: dirent.name,
        });
      }
    }
  };

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

  it("keeps bundled channel secret contracts on packed top-level sidecars", () => {
    const artifacts = listBundledPluginPackArtifacts();
    const excludedPackageDirs = collectRootPackageExcludedExtensionDirs();
    const offenders: string[] = [];
    const secretBackedPluginIds = new Set<string>();

    forEachBundledChannelEntry(({ entryPath, entry, pluginId }) => {
      if (!entry.includes('exportName: "channelSecrets"')) {
        return;
      }
      secretBackedPluginIds.add(pluginId);
      if (entry.includes("./src/secret-contract.js")) {
        offenders.push(entryPath);
      }
      expect(entry).toContain('specifier: "./secret-contract-api.js"');
    });

    expect(offenders).toStrictEqual([]);

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
