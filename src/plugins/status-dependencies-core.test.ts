import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hostRootResolver from "../infra/openclaw-root.js";
import {
  buildManagedPluginDependencyStatus,
  buildPluginDependencyStatus,
  findMissingRequiredPluginDependencies,
  normalizePluginDependencySpecs,
} from "./status-dependencies-core.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanupTrackedTempDirs(tempDirs);
});

function createPluginRoot() {
  return makeTrackedTempDir("openclaw-plugin-dependency-status", tempDirs);
}

function writeDependency(rootDir: string, name: string) {
  const packageDir = path.join(rootDir, "node_modules", name);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  return packageDir;
}

function createHostFixture() {
  const parent = createPluginRoot();
  const projectRoot = path.join(parent, "project");
  const rootDir = writeDependency(projectRoot, "@example/plugin");
  const hostRoot = hostRootResolver.resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (!hostRoot) {
    throw new Error("Expected the running OpenClaw package root");
  }
  return { parent, projectRoot, rootDir, hostRoot };
}

function linkHost(rootDir: string, hostRoot: string) {
  fs.mkdirSync(path.join(rootDir, "node_modules"), { recursive: true });
  fs.symlinkSync(hostRoot, path.join(rootDir, "node_modules", "openclaw"), "junction");
}

describe("plugin dependency health", () => {
  it.each([
    "missing",
    "directory",
    "file",
    "empty-manifest",
    "malformed-manifest",
    "directory-manifest",
  ])("rejects a required dependency with a %s package payload", (payload) => {
    const rootDir = createPluginRoot();
    const dependencyDir = path.join(rootDir, "node_modules", "required-runtime");
    if (payload === "directory") {
      fs.mkdirSync(dependencyDir, { recursive: true });
    } else if (payload === "file") {
      fs.mkdirSync(path.dirname(dependencyDir));
      fs.writeFileSync(dependencyDir, "not a package");
    }
    if (payload.endsWith("manifest")) {
      fs.mkdirSync(dependencyDir, { recursive: true });
      const manifest = path.join(dependencyDir, "package.json");
      if (payload === "directory-manifest") {
        fs.mkdirSync(manifest);
      } else {
        fs.writeFileSync(manifest, payload === "empty-manifest" ? "" : "{");
      }
    }
    const status = buildPluginDependencyStatus({
      rootDir,
      dependencies: { "required-runtime": "1.0.0" },
    });
    expect(status.installed).toBe(false);
    expect(status.requiredInstalled).toBe(false);
    expect(status.missing).toEqual(["required-runtime"]);
    expect(status.dependencies[0]?.resolvedPath).toBeUndefined();
  });

  it.each([
    { name: "required-runtime", layout: "nested" },
    { name: "@example/required-runtime", layout: "nested" },
    { name: "required-runtime", layout: "hoisted" },
    { name: "required-runtime", layout: "ancestor" },
  ])("resolves $name from a $layout generic installation", ({ name, layout }) => {
    const { parent, projectRoot, rootDir } = createHostFixture();
    const availableDir = writeDependency(
      layout === "nested" ? rootDir : layout === "hoisted" ? projectRoot : parent,
      name,
    );
    if (layout === "hoisted") {
      fs.mkdirSync(path.join(rootDir, "node_modules", name), { recursive: true });
    }
    const status = buildPluginDependencyStatus({ rootDir, dependencies: { [name]: "1.0.0" } });
    expect(status.installed).toBe(true);
    expect(status.requiredInstalled).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.dependencies[0]?.resolvedPath).toBe(availableDir);
  });

  it.each(["nested", "hoisted", "inside-symlink", "missing", "ancestor", "outside-symlink"])(
    "keeps ordinary %s dependency lookup bounded when the canonical host is exempted",
    async (layout) => {
      const { parent, projectRoot, rootDir, hostRoot } = createHostFixture();
      linkHost(rootDir, hostRoot);
      const dependencyDir = path.join(rootDir, "node_modules", "required-runtime");
      if (layout === "nested") {
        writeDependency(rootDir, "required-runtime");
      } else if (layout === "hoisted") {
        fs.mkdirSync(dependencyDir);
        writeDependency(projectRoot, "required-runtime");
      } else if (layout !== "missing") {
        const targetDir = writeDependency(
          layout === "inside-symlink" ? projectRoot : parent,
          "required-runtime",
        );
        if (layout.endsWith("symlink")) {
          fs.symlinkSync(targetDir, dependencyDir, "junction");
        }
      }
      const params = {
        rootDir,
        dependencyRootDir: projectRoot,
        dependencies: { "required-runtime": "1.0.0" },
        optionalDependencies: { "optional-runtime": "1.0.0" },
      };
      const installed = ["nested", "hoisted", "inside-symlink"].includes(layout);
      const missing = installed ? [] : ["required-runtime"];
      const status = buildPluginDependencyStatus(params);
      expect(status.requiredInstalled).toBe(installed);
      expect(status.missing).toEqual(missing);
      expect(status.missingOptional).toEqual(["optional-runtime"]);
      expect(
        await findMissingRequiredPluginDependencies({
          ...params,
          dependencies: { ...params.dependencies, openclaw: "*" },
        }),
      ).toEqual(missing);
    },
  );

  it.each(["hardlink", "inside-link", "outside-link", "malformed-shadow"] as const)(
    "checks a %s dependency manifest without hiding local corruption",
    (layout) => {
      const { parent, projectRoot, rootDir } = createHostFixture();
      const dependencyDir = writeDependency(rootDir, "required-runtime");
      const manifest = path.join(dependencyDir, "package.json");
      if (layout === "hardlink") {
        fs.linkSync(manifest, path.join(projectRoot, "manifest-link.json"));
      } else if (layout === "malformed-shadow") {
        writeDependency(projectRoot, "required-runtime");
        fs.writeFileSync(manifest, "{");
      } else {
        const target = path.join(layout === "inside-link" ? projectRoot : parent, "manifest.json");
        fs.writeFileSync(target, JSON.stringify({ name: "required-runtime", version: "1.0.0" }));
        fs.unlinkSync(manifest);
        fs.symlinkSync(target, manifest);
      }
      const status = buildPluginDependencyStatus({
        rootDir,
        dependencyRootDir: projectRoot,
        dependencies: { "required-runtime": "1.0.0" },
      });
      expect(status.requiredInstalled).toBe(layout === "hardlink" || layout === "inside-link");
    },
  );

  it.each([
    { bytes: 1024 * 1024, installed: true },
    { bytes: 1024 * 1024 + 1, installed: false },
  ])("bounds a $bytes-byte dependency manifest", ({ bytes, installed }) => {
    const rootDir = createPluginRoot();
    const dependencyDir = writeDependency(rootDir, "required-runtime");
    const manifest = JSON.stringify({ name: "required-runtime", version: "1.0.0" });
    fs.writeFileSync(path.join(dependencyDir, "package.json"), manifest.padEnd(bytes, " "));
    const status = buildPluginDependencyStatus({
      rootDir,
      dependencies: { "required-runtime": "1.0.0" },
    });
    expect(status.requiredInstalled).toBe(installed);
  });

  it.each(["project-alias", "outside-project", "missing-project"])(
    "applies canonical project bounds through %s",
    async (layout) => {
      const { parent, projectRoot, rootDir, hostRoot } = createHostFixture();
      linkHost(rootDir, hostRoot);
      const availableDir = writeDependency(projectRoot, "required-runtime");
      const alias = path.join(parent, "alias");
      fs.symlinkSync(projectRoot, alias, "junction");
      const installed = layout === "project-alias";
      const params = {
        rootDir: installed ? path.join(alias, "node_modules", "@example/plugin") : rootDir,
        dependencyRootDir: installed
          ? projectRoot
          : layout === "outside-project"
            ? createPluginRoot()
            : path.join(parent, "different-project"),
      };
      const status = buildPluginDependencyStatus({
        ...params,
        dependencies: { "required-runtime": "1.0.0" },
      });
      expect(status.requiredInstalled).toBe(installed);
      expect(status.missing).toEqual(installed ? [] : ["required-runtime"]);
      if (installed) {
        expect(fs.realpathSync(status.dependencies[0]?.resolvedPath ?? "<unresolved>")).toBe(
          availableDir,
        );
      }
      expect(
        await findMissingRequiredPluginDependencies({ ...params, dependencies: { openclaw: "*" } }),
      ).toEqual(installed ? [] : ["openclaw"]);
    },
  );

  it.each([undefined, {}, { openclaw: "*", "optional-runtime": "1.0.0" }])(
    "keeps optional overrides out of required failures and host audits: %j",
    async (dependencies) => {
      const rootDir = createPluginRoot();
      const resolver = vi
        .spyOn(hostRootResolver, "resolveOpenClawPackageRootSync")
        .mockImplementation(() => {
          throw new Error("No required host needs auditing");
        });
      const params = {
        rootDir,
        dependencyRootDir: rootDir,
        ...normalizePluginDependencySpecs({
          dependencies,
          optionalDependencies: { openclaw: "*", "optional-runtime": "2.0.0" },
        }),
      };
      const status = buildPluginDependencyStatus(params);
      expect(status.installed).toBe(true);
      expect(status.missing).toEqual([]);
      expect(status.missingOptional).toEqual(["openclaw", "optional-runtime"]);
      expect(status.dependencies).toEqual([]);
      expect(
        status.optionalDependencies.find((entry) => entry.name === "optional-runtime")?.spec,
      ).toBe("2.0.0");
      expect(await findMissingRequiredPluginDependencies(params)).toEqual([]);
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it.each([
    "canonical",
    "missing",
    "empty",
    "copy",
    "wrong-target",
    "linked-node-modules",
    "hoisted-host",
    "unknown-host",
  ] as const)("audits a required OpenClaw host with a %s layout", async (layout) => {
    const { parent, projectRoot, rootDir, hostRoot } = createHostFixture();
    if (layout === "canonical" || layout === "unknown-host") {
      linkHost(rootDir, hostRoot);
    } else if (layout === "copy") {
      writeDependency(rootDir, "openclaw");
    } else if (layout === "empty") {
      fs.mkdirSync(path.join(rootDir, "node_modules", "openclaw"), { recursive: true });
    } else if (layout === "wrong-target") {
      linkHost(rootDir, writeDependency(parent, "openclaw"));
    } else if (layout === "linked-node-modules") {
      const externalRoot = path.join(parent, "external");
      linkHost(externalRoot, hostRoot);
      fs.symlinkSync(
        path.join(externalRoot, "node_modules"),
        path.join(rootDir, "node_modules"),
        "junction",
      );
    } else if (layout === "hoisted-host") {
      linkHost(projectRoot, hostRoot);
    }
    if (layout === "unknown-host") {
      vi.spyOn(hostRootResolver, "resolveOpenClawPackageRootSync").mockReturnValue(null);
    }
    const params = { rootDir, dependencyRootDir: projectRoot, dependencies: { openclaw: "*" } };
    expect(await findMissingRequiredPluginDependencies(params)).toEqual(
      layout === "canonical" ? [] : ["openclaw"],
    );
    expect(buildManagedPluginDependencyStatus(params).requiredInstalled).toBe(
      layout === "canonical",
    );
    // Generic status accepts a package copy; managed status requires the canonical host.
    expect(buildPluginDependencyStatus(params).requiredInstalled).toBe(layout === "copy");
  });

  it.each(["", "missing"])("rejects an unavailable plugin root: %j", async (root) => {
    const projectRoot = createPluginRoot();
    expect(
      await findMissingRequiredPluginDependencies({
        rootDir: root === "missing" ? path.join(projectRoot, root) : root,
        dependencyRootDir: projectRoot,
        dependencies: { openclaw: "*" },
      }),
    ).toEqual(["openclaw"]);
  });
});
