import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { valid } from "semver";
import { installedPackagePath } from "../../../scripts/lib/package-installed-dependencies.mts";
import { sha256File } from "../../infra/directory-durability.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { readPackageManifest, type NodePackageManifest } from "./node-bootstrap-package.js";

export type DependencyManifest = NodePackageManifest;

export type NodeBootstrapDependency = {
  requestedName: string;
  root: string;
  prefix: string;
  manifest: DependencyManifest;
};

/** Materialize Node's installed dependency graph, retaining nested version contexts without links. */
export async function collectNodeBootstrapDependencies(
  root: string,
  manifest: DependencyManifest,
  target: { platform: string; arch: string },
  dependencyRoots: ReadonlyMap<string, string> = new Map(),
): Promise<NodeBootstrapDependency[]> {
  const result: NodeBootstrapDependency[] = [];
  const rootPlacements = new Map<string, string>();
  const visit = async (
    source: string,
    parent: DependencyManifest,
    prefix: string,
    ancestors: readonly ReadonlyMap<string, string>[],
  ): Promise<void> => {
    const dependencies = {
      ...parent.peerDependencies,
      ...parent.dependencies,
      ...parent.optionalDependencies,
    };
    const children: Array<
      NodeBootstrapDependency & { ancestors: readonly ReadonlyMap<string, string>[] }
    > = [];
    const placements = new Map<string, string>();
    for (const [name, spec] of Object.entries(dependencies).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      // A plugin's OpenClaw peer is its enclosing runtime, not another installation.
      if (name === manifest.name) {
        continue;
      }
      const optional =
        name in (parent.optionalDependencies ?? {}) ||
        (!Object.hasOwn(parent.dependencies ?? {}, name) &&
          parent.peerDependenciesMeta?.[name]?.optional === true);
      // Composed plugin pins retain their installation owner; a Gateway development
      // dependency with the same name must not shadow that production graph.
      const owner = !prefix ? (dependencyRoots.get(name) ?? source) : source;
      let installed = await installedPackagePath(owner, name);
      if (!installed) {
        if (optional) {
          continue;
        }
        throw new Error(
          `Node runtime dependency is not installed: ${parent.name} requires ${name}`,
        );
      }
      installed = await fs.realpath(installed);
      const value = await readPackageManifest(installed);
      // The frozen-lock install owns transitive overrides and peer resolution. Preserve
      // those resolved identities rather than implementing a second package resolver here.
      const expectedName = spec.startsWith("npm:") ? spec.slice(4, spec.lastIndexOf("@")) : name;
      if (
        (!prefix && value.name !== expectedName) ||
        (!prefix && valid(spec) === spec && value.version !== spec)
      ) {
        throw new Error(`Node runtime dependency identity mismatch: ${name}@${spec}`);
      }
      const supports = (values: string[] | undefined, wanted: string) =>
        !values ||
        (!values.includes(`!${wanted}`) &&
          (!values.some((candidate) => !candidate.startsWith("!")) || values.includes(wanted)));
      if (!supports(value.os, target.platform) || !supports(value.cpu, target.arch)) {
        if (optional) {
          continue;
        }
        throw new Error(
          `Node runtime dependency ${name} does not support ${target.platform}/${target.arch}`,
        );
      }
      // Only the nearest visible placement may satisfy this edge: a nearer different
      // version shadows a matching root package. This also closes dependency cycles.
      const visible = ancestors.find((scope) => scope.has(name))?.get(name);
      if (visible === installed) {
        continue;
      }
      const hoisted = !rootPlacements.has(name);
      const destination = `${hoisted ? "" : prefix}node_modules/${name}/`;
      if (destination.split("/").length > 64) {
        throw new Error("Node runtime dependency nesting exceeds the archive depth limit");
      }
      if (hoisted) {
        rootPlacements.set(name, installed);
      } else {
        placements.set(name, installed);
      }
      const child = { requestedName: name, root: installed, prefix: destination, manifest: value };
      result.push(child);
      children.push({
        ...child,
        ancestors: hoisted ? [rootPlacements] : [placements, ...ancestors],
      });
    }
    for (const child of children) {
      await visit(child.root, child.manifest, child.prefix, child.ancestors);
    }
  };
  await visit(root, manifest, "", []);
  return result;
}

export type NodeBootstrapDependencyTarget = {
  platform: string;
  arch: string;
  root: string;
  prefix: string;
};

/** Offline inputs are qualified against the same installed source and frozen lock. */
export async function collectNodeBootstrapDependencyTargets(
  packageRoot: string,
  sourcePackage: DependencyManifest,
): Promise<NodeBootstrapDependencyTarget[]> {
  const targets: NodeBootstrapDependencyTarget[] = [
    { platform: process.platform, arch: process.arch, root: packageRoot, prefix: "" },
  ];
  const targetInputs = path.join(packageRoot, "node-runtime-dependencies");
  for (const entry of await fs
    .readdir(targetInputs, { withFileTypes: true })
    .then((entries) => entries.toSorted((left, right) => left.name.localeCompare(right.name)))
    .catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    })) {
    if (!entry.isDirectory() || !/^(linux|darwin|win32)-(x64|arm64)$/u.test(entry.name)) {
      throw new Error("Invalid node runtime dependency target input");
    }
    const separator = entry.name.indexOf("-");
    const platform = entry.name.slice(0, separator);
    const arch = entry.name.slice(separator + 1);
    if (platform === process.platform && arch === process.arch) {
      continue;
    }
    const root = await fs.realpath(path.join(targetInputs, entry.name));
    if (root !== path.join(targetInputs, entry.name)) {
      throw new Error("Node runtime target input path is unsafe");
    }
    const inputPackage = await readPackageManifest(root);
    const input: unknown = JSON.parse(
      await fs.readFile(path.join(root, "runtime-input.json"), "utf8"),
    );
    if (
      !isRecord(input) ||
      input.platform !== platform ||
      input.arch !== arch ||
      input.packageJsonSha256 !==
        (await sha256File(path.join(packageRoot, "package.json"))).digest ||
      input.lockfileSha256 !==
        (await sha256File(path.join(packageRoot, "pnpm-lock.yaml"))).digest ||
      inputPackage.name !== sourcePackage.name ||
      inputPackage.version !== sourcePackage.version ||
      !isDeepStrictEqual(inputPackage.dependencies, sourcePackage.dependencies) ||
      !isDeepStrictEqual(inputPackage.optionalDependencies, sourcePackage.optionalDependencies)
    ) {
      throw new Error(
        `Node runtime target ${entry.name} does not match the running source/dependencies`,
      );
    }
    targets.push({ platform, arch, root, prefix: `runtime-dependencies/${entry.name}/` });
  }
  return targets;
}
