import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hostRootResolver from "../infra/openclaw-root.js";
import {
  buildManagedPluginDependencyStatus,
  buildPluginDependencyStatus,
  normalizePluginDependencySpecs,
} from "./status-dependencies-core.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const required = { "required-runtime": "1.0.0" };
const packageManifest = (name: string) => JSON.stringify({ name, version: "1.0.0" });

function expectRequired(
  status: ReturnType<typeof buildPluginDependencyStatus>,
  installed: boolean,
  name = "required-runtime",
) {
  expect(status).toMatchObject({ installed, requiredInstalled: installed });
  expect(status.missing).toEqual(installed ? [] : [name]);
}

function dependencyStatus(rootDir: string, dependencyRootDir?: string) {
  return buildPluginDependencyStatus({ rootDir, dependencyRootDir, dependencies: required });
}

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
  fs.writeFileSync(path.join(packageDir, "package.json"), packageManifest(name));
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
  it.each(["missing", "directory-manifest"])(
    "rejects a required dependency with a %s package payload",
    (payload) => {
      const rootDir = createPluginRoot();
      if (payload === "directory-manifest") {
        fs.mkdirSync(path.join(rootDir, "node_modules/required-runtime/package.json"), {
          recursive: true,
        });
      }
      const status = dependencyStatus(rootDir);
      expectRequired(status, false);
      expect(status.dependencies[0]?.resolvedPath).toBeUndefined();
    },
  );

  it.each([
    ["required-runtime", "nested", false],
    ["@example/required-runtime", "nested", false],
    ["required-runtime", "hoisted", false],
    ["required-runtime", "ancestor", false],
    ["required-runtime", "nested", true],
    ["required-runtime", "hoisted", true],
    ["required-runtime", "inside-symlink", true],
    ["required-runtime", "missing", true],
    ["required-runtime", "ancestor", true],
    ["required-runtime", "outside-symlink", true],
  ] as const)("resolves %s in %s layout (bounded: %s)", (name, layout, bounded) => {
    const { parent, projectRoot, rootDir, hostRoot } = createHostFixture();
    const dependencyDir = path.join(rootDir, "node_modules", name);
    const owner =
      layout === "nested"
        ? rootDir
        : ["hoisted", "inside-symlink"].includes(layout)
          ? projectRoot
          : parent;
    const availableDir = layout === "missing" ? undefined : writeDependency(owner, name);
    if (bounded) {
      linkHost(rootDir, hostRoot);
    }
    if (layout === "hoisted") {
      fs.mkdirSync(dependencyDir, { recursive: true });
    } else if (layout.endsWith("symlink") && availableDir) {
      fs.symlinkSync(availableDir, dependencyDir, "junction");
    }
    const params = {
      rootDir,
      dependencyRootDir: bounded ? projectRoot : undefined,
      dependencies: { [name]: "1.0.0" },
      optionalDependencies: bounded ? { "optional-runtime": "1.0.0" } : undefined,
    };
    const installed = !bounded || ["nested", "hoisted", "inside-symlink"].includes(layout);
    const status = buildPluginDependencyStatus(params);
    expectRequired(status, installed, name);
    if (bounded) {
      expect(status.missingOptional).toEqual(["optional-runtime"]);
      expect(
        buildManagedPluginDependencyStatus({
          ...params,
          dependencyRootDir: projectRoot,
          dependencies: { ...params.dependencies, openclaw: "*" },
        }).missing,
      ).toEqual(installed ? [] : [name]);
    } else {
      expect(status.dependencies[0]?.resolvedPath).toBe(availableDir);
    }
  });

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
        fs.writeFileSync(target, packageManifest("required-runtime"));
        fs.unlinkSync(manifest);
        fs.symlinkSync(target, manifest);
      }
      const status = dependencyStatus(rootDir, projectRoot);
      expect(status.requiredInstalled).toBe(layout === "hardlink" || layout === "inside-link");
    },
  );

  it.each([
    { bytes: 1024 * 1024, installed: true },
    { bytes: 1024 * 1024 + 1, installed: false },
  ])("bounds a $bytes-byte dependency manifest", ({ bytes, installed }) => {
    const rootDir = createPluginRoot();
    const dependencyDir = writeDependency(rootDir, "required-runtime");
    const manifest = packageManifest("required-runtime");
    fs.writeFileSync(path.join(dependencyDir, "package.json"), manifest.padEnd(bytes, " "));
    const status = dependencyStatus(rootDir);
    expect(status.requiredInstalled).toBe(installed);
  });

  it.each(["project-alias", "outside-project", "missing-project"])(
    "applies canonical project bounds through %s",
    (layout) => {
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
      const status = dependencyStatus(params.rootDir, params.dependencyRootDir);
      expectRequired(status, installed);
      if (installed) {
        expect(fs.realpathSync(status.dependencies[0]?.resolvedPath ?? "<unresolved>")).toBe(
          availableDir,
        );
      }
      expect(
        buildManagedPluginDependencyStatus({ ...params, dependencies: { openclaw: "*" } }).missing,
      ).toEqual(installed ? [] : ["openclaw"]);
    },
  );

  it.each([undefined, {}, { openclaw: "*", "optional-runtime": "1.0.0" }])(
    "keeps optional overrides out of required failures and host audits: %j",
    (dependencies) => {
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
      expect(buildManagedPluginDependencyStatus(params).missing).toEqual([]);
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
  ] as const)("audits a required OpenClaw host with a %s layout", (layout) => {
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
    expect(buildManagedPluginDependencyStatus(params).missing).toEqual(
      layout === "canonical" ? [] : ["openclaw"],
    );
    expect(buildManagedPluginDependencyStatus(params).requiredInstalled).toBe(
      layout === "canonical",
    );
    // Generic status accepts a package copy; managed status requires the canonical host.
    expect(buildPluginDependencyStatus(params).requiredInstalled).toBe(layout === "copy");
  });

  it.each(["", "missing"])("rejects an unavailable plugin root: %j", (root) => {
    const projectRoot = createPluginRoot();
    expect(
      buildManagedPluginDependencyStatus({
        rootDir: root === "missing" ? path.join(projectRoot, root) : root,
        dependencyRootDir: projectRoot,
        dependencies: { openclaw: "*" },
      }).missing,
    ).toEqual(["openclaw"]);
  });
});
