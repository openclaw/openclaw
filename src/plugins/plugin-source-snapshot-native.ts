import { createRequire } from "node:module";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import {
  capturePluginNativeNamespace,
  finishPluginNativeNamespace,
  pluginNativeNamespaceIsCurrent,
  pluginNativeNamespaceMemberPath,
} from "./plugin-native-namespace.js";
import type { PluginNativeNamespaceFact } from "./plugin-source-admission.types.js";
import { createPluginNativeCaptureRoot } from "./plugin-source-capture-directory.js";
import { recordPluginNativeLoad } from "./plugin-source-capture-native-loads.js";
import { isPluginSourceEntry } from "./plugin-source-file.js";
import {
  PluginSourceSnapshotValidationError,
  type AcquiredPluginSharedSourceSnapshot,
} from "./plugin-source-snapshot-artifact.js";

type ExpectedMember = { source: string; logical: string };
type Namespace = {
  fact: PluginNativeNamespaceFact;
  expected: ReadonlyMap<string, ExpectedMember>;
  root: ReturnType<typeof createPluginNativeCaptureRoot>;
};

/**
 * Native addons retain real, private companion paths and the existing mapped-image owner.
 * A plugin-root owner deliberately keeps whole-plugin admission: arbitrary companions
 * are part of the native contract, so this path is exempt from constant-work startup.
 */
export function createPluginSharedSnapshotNativeLoader(
  snapshot: AcquiredPluginSharedSourceSnapshot,
) {
  const retained = snapshot.retain();
  const namespaces = new Map<string, Namespace>();
  const require = createRequire(import.meta.url);
  let disposed = false;
  function fail(filename: string, detail: string): never {
    throw new PluginSourceSnapshotValidationError(
      snapshot.descriptor.artifact.path,
      `native snapshot member ${filename}: ${detail}`,
    );
  }
  const canonical = (filename: string) => {
    let selected = path.resolve(filename);
    for (let count = 0; count <= snapshot.sourceLinks.size; count++) {
      let link: string | undefined;
      for (let parent = selected; isPathInside(snapshot.payloadRoot, parent);) {
        if (snapshot.sourceLinks.has(parent)) {
          link = parent;
          break;
        }
        const next = path.dirname(parent);
        if (next === parent) {
          break;
        }
        parent = next;
      }
      if (!link) {
        return selected;
      }
      selected = path.join(snapshot.sourceLinks.get(link)!, path.relative(link, selected));
    }
    return fail(filename, "dependency link cycle");
  };
  const packageRoot = (filename: string) => {
    for (let parent = path.dirname(filename); isPathInside(snapshot.payloadRoot, parent);) {
      if (path.basename(parent) === "node_modules") {
        break;
      }
      if (snapshot.resolution.has(parent)) {
        return parent;
      }
      const next = path.dirname(parent);
      if (next === parent) {
        break;
      }
      parent = next;
    }
    return path.dirname(filename);
  };
  const children = new Map<string, string[]>();
  const expectedNamespace = (directory: string) => {
    if (!children.size) {
      for (const filename of snapshot.entries.keys()) {
        const parent = path.dirname(filename);
        const siblings = children.get(parent) ?? [];
        siblings.push(filename);
        children.set(parent, siblings);
      }
    }
    const members = new Map<string, ExpectedMember>();
    const directories = new Set<string>();
    const dependency = (name: string, importer: string) => {
      for (let parent = importer; isPathInside(snapshot.payloadRoot, parent);) {
        if (path.basename(parent) !== "node_modules") {
          const logical = path.join(parent, "node_modules", name);
          const source = canonical(logical);
          if (snapshot.resolution.has(source)) {
            return { logical, source };
          }
        }
        const next = path.dirname(parent);
        if (next === parent) {
          break;
        }
        parent = next;
      }
      return undefined;
    };
    const visit = (
      logical: string,
      relative: string,
      admittedDependency = false,
      boundary = snapshot.payloadRoot,
    ) => {
      const source = canonical(logical);
      const entry = snapshot.entries.get(source);
      if (!entry || entry.kind === "link") {
        fail(logical, "missing authenticated member");
      }
      members.set(relative, { source, logical });
      if (entry.kind !== "directory" || directories.has(source)) {
        return;
      }
      directories.add(source);
      for (const child of children.get(source) ?? []) {
        if (isPluginSourceEntry(path.basename(child))) {
          visit(child, path.join(relative, path.basename(child)), false, boundary);
        }
      }
      const root = relative ? source : packageRoot(path.join(source, "native-companion.cjs"));
      const text = snapshot.resolution.get(root);
      if (!text || !isPathInside(boundary, root)) {
        return;
      }
      // SAFETY: Only checked unknown-valued dependency fields are consumed from authenticated package text.
      const manifest = JSON.parse(text) as Record<string, unknown>;
      const names = new Set<string>();
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        const value = manifest[field];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const name of Object.keys(value)) {
            names.add(name);
          }
        }
      }
      for (const name of [...names].toSorted()) {
        if (name === "openclaw" || name === "@openclaw/plugin-sdk") {
          continue;
        }
        const selected = dependency(name, root);
        if (selected) {
          visit(selected.logical, path.join(relative, "node_modules", name), true, selected.source);
        } else if (!relative || admittedDependency) {
          const required = manifest.dependencies;
          const optional = manifest.optionalDependencies;
          const peer = manifest.peerDependencies;
          if (
            required &&
            typeof required === "object" &&
            Object.hasOwn(required, name) &&
            !(optional && typeof optional === "object" && Object.hasOwn(optional, name)) &&
            !(peer && typeof peer === "object" && Object.hasOwn(peer, name))
          ) {
            fail(root, `missing authenticated dependency ${name}`);
          }
        }
      }
    };
    visit(directory, "");
    return members;
  };
  const verify = ({ fact, expected }: Namespace) => {
    retained.assertCurrent();
    if (Object.keys(fact.members).length !== expected.size) {
      fail(fact.sourceDirectory, "native namespace membership changed");
    }
    for (const [relative, selected] of expected) {
      const member = fact.members[relative];
      const entry = snapshot.entries.get(selected.source);
      if (!member || !entry || member.source !== selected.source) {
        fail(selected.logical, "native namespace membership changed");
      }
      if (member.sourceIdentity !== entry.identity) {
        fail(selected.logical, "source identity changed");
      }
      if (entry.kind === "file") {
        if (member.sizeBytes !== entry.sizeBytes || member.contentHash !== entry.contentHash) {
          fail(selected.logical, "copied native companion differs from authenticated bytes");
        }
        // The guarded read verifies the same manifest digest and its full member path.
        retained.readVerifiedFile(selected.logical);
      } else {
        retained.assertMemberPath(selected.logical);
      }
    }
    if (!pluginNativeNamespaceIsCurrent(fact, snapshot.payloadRoot)) {
      fail(fact.sourceDirectory, "native companion identity or membership changed");
    }
  };
  return {
    load(filename: string): unknown {
      if (disposed) {
        throw new Error("Plugin shared native loader has closed");
      }
      retained.assertMemberPath(filename);
      const source = canonical(filename);
      const directory = packageRoot(source);
      let namespace = namespaces.get(directory);
      if (!namespace) {
        const expected = expectedNamespace(directory);
        const root = createPluginNativeCaptureRoot(snapshot.stateDir, "state");
        try {
          const { fact } = capturePluginNativeNamespace({
            sourceDirectory: directory,
            boundary: snapshot.payloadRoot,
            capturedRoot: root.directory,
            managed: true,
            copyOnly: true,
          });
          finishPluginNativeNamespace(fact);
          namespace = { fact, expected, root };
          verify(namespace);
          namespaces.set(directory, namespace);
        } catch (error) {
          root.dispose();
          throw error;
        }
      } else {
        verify(namespace);
      }
      const selected = [...namespace.expected].find(([, member]) => member.source === source);
      if (!selected) {
        return fail(filename, "addon is outside its native namespace");
      }
      const target = pluginNativeNamespaceMemberPath(namespace.fact, selected[0]);
      recordPluginNativeLoad(target);
      return require(target);
    },
    async disposeAsync() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        for (const { root } of namespaces.values()) {
          await root.disposeAsync();
        }
      } finally {
        namespaces.clear();
        await retained.releaseAsync();
      }
    },
  };
}
