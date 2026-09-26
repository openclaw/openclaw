import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
} from "./installed-plugin-index-types.js";
import { resolveRetainedManagedNpmInstallPackageInfo } from "./managed-npm-retention.js";
import { safeRealpathSync } from "./path-safety.js";
import { getPluginCache } from "./plugin-cache.js";
import type { PluginCache } from "./plugin-cache.types.js";
import type {
  PluginNativeArtifactFact,
  PluginNativeNamespaceFact,
  PluginSourceAdmissionReceipt,
} from "./plugin-source-admission.types.js";
import {
  createPluginNativeCaptureRoot,
  retainPluginNativeCapturePath,
} from "./plugin-source-capture-directory.js";

type NativeSnapshot = ReturnType<typeof createPluginNativeCaptureRoot>;
export type AdmissionState = {
  owners: Map<string, InstalledPluginIndexRecord>;
  managedRoots: Map<string, "retained-npm" | "installed">;
  receipts: Map<string, PluginSourceAdmissionReceipt>;
  files: Map<string, PluginNativeArtifactFact>;
  namespaces: Map<string, PluginNativeNamespaceFact>;
  pins: Map<string, () => void>;
  roots: Set<NativeSnapshot>;
  pending: Set<Promise<void>>;
  publications: Map<string, () => Promise<void>>;
  publishing: Set<string>;
  borrowers: Set<object>;
};
const admissions = new WeakMap<PluginCache, AdmissionState>();
const admissionScopes = new WeakMap<PluginCache, Set<AdmissionState>>();
export const snapshotOwners = new WeakMap<NativeSnapshot, Set<object>>();

export function retainNativePath(state: AdmissionState, filename: string): void {
  if (!state.pins.has(filename)) {
    state.pins.set(filename, retainPluginNativeCapturePath(filename));
  }
}

export async function settlePluginNativeAdmissions(cache = getPluginCache()): Promise<void> {
  const state = admissions.get(cache);
  if (state) {
    await settleAdmissionState(state);
  }
}

async function settleAdmissionState(state: AdmissionState): Promise<void> {
  await Promise.all(state.pending);
  // Explicit settlement also drains a newer receipt queued behind an earlier write.
  for (const key of state.publications.keys()) {
    startNativeAdmissionPublication(state, key);
  }
  await Promise.all(state.pending);
}

export function startNativeAdmissionPublication(state: AdmissionState, key: string): void {
  const publish = state.publications.get(key);
  if (!publish || state.publishing.has(key)) {
    return;
  }
  state.publishing.add(key);
  const pending = publish().finally(() => {
    state.publishing.delete(key);
    state.pending.delete(pending);
  });
  state.pending.add(pending);
}

function bindAdmissionState(cache: PluginCache, state: AdmissionState): AdmissionState {
  let scope = admissionScopes.get(cache);
  if (!scope) {
    scope = new Set();
    admissionScopes.set(cache, scope);
    const held = scope;
    cache.sourceAdmissions = {
      invalidate() {
        // Existing generations keep their facts; the next admission starts a new snapshot.
        admissions.delete(cache);
      },
      async dispose() {
        for (const owned of held) {
          await Promise.all(owned.pending);
          owned.borrowers.delete(held);
          if (owned.borrowers.size > 0) {
            continue;
          }
          await settleAdmissionState(owned);
          for (const release of owned.pins.values()) {
            release();
          }
          owned.pins.clear();
          const released = [...owned.roots].filter((root) => {
            const owners = snapshotOwners.get(root)!;
            owners.delete(owned);
            return owners.size === 0;
          });
          await Promise.all(released.map((root) => root.disposeAsync()));
          owned.roots.clear();
        }
        held.clear();
        admissions.delete(cache);
        admissionScopes.delete(cache);
      },
    };
  }
  scope.add(state);
  state.borrowers.add(scope);
  admissions.set(cache, state);
  return state;
}

export function nativeAdmissionStateFor(cache = getPluginCache()): AdmissionState {
  const state = admissions.get(cache);
  return (
    state ??
    bindAdmissionState(cache, {
      owners: new Map(),
      managedRoots: new Map(),
      receipts: new Map(),
      files: new Map(),
      namespaces: new Map(),
      pins: new Map(),
      roots: new Set(),
      pending: new Set(),
      publications: new Map(),
      publishing: new Set(),
      borrowers: new Set(),
    })
  );
}

/** Private inspection caches share admitted payload custody, never registration authority. */
export function inheritPluginNativeAdmissions(
  sourceCache: PluginCache,
  targetCache: PluginCache,
): void {
  if (sourceCache !== targetCache) {
    bindAdmissionState(targetCache, nativeAdmissionStateFor(sourceCache));
  }
}

/** Carry prepared receipts to workers without mutating the published metadata snapshot. */
export function overlayPluginNativeAdmissions(
  index: InstalledPluginIndex,
  cache: PluginCache,
): InstalledPluginIndex {
  const state = admissions.get(cache);
  if (!state || state.receipts.size === 0) {
    return index;
  }
  return {
    ...index,
    plugins: index.plugins.map((record) => {
      const prefix = `${path.resolve(record.rootDir)}\0`;
      const receipts = [...state.receipts].filter(([key]) => key.startsWith(prefix));
      return receipts.length
        ? {
            ...record,
            sourceAdmissions: {
              ...record.sourceAdmissions,
              ...structuredClone(Object.fromEntries(receipts)),
            },
          }
        : record;
    }),
  };
}

/** Seed the existing cache generation once from its admitted installed-index payload. */
export function preparePluginNativeAdmissions(
  index: InstalledPluginIndex,
  cache = getPluginCache(),
): void {
  const state = nativeAdmissionStateFor(cache);
  for (const record of index.plugins) {
    const root = path.resolve(record.rootDir);
    if (state.owners.has(root)) {
      continue;
    }
    state.owners.set(root, record);
    const installOwner = resolveInstalledPluginIndexInstallOwner(record);
    const install = installOwner ? index.installRecords[installOwner] : undefined;
    const installRoot = install?.installPath
      ? (safeRealpathSync(install.installPath) ?? path.resolve(install.installPath))
      : undefined;
    if (
      install &&
      installRoot !== undefined &&
      isPathInside(installRoot, safeRealpathSync(root) ?? root)
    ) {
      if (install.source === "npm") {
        const project = resolveRetainedManagedNpmInstallPackageInfo(installRoot);
        state.managedRoots.set(
          project?.projectRoot ?? installRoot,
          project ? "retained-npm" : "installed",
        );
      } else if (
        ["archive", "clawhub", "marketplace", "git"].includes(install.source) ||
        (install.source === "path" &&
          install.sourcePath &&
          (safeRealpathSync(install.sourcePath) ?? path.resolve(install.sourcePath)) !==
            installRoot)
      ) {
        state.managedRoots.set(installRoot, "installed");
      }
    }
    for (const [key, receipt] of Object.entries(record.sourceAdmissions ?? {})) {
      state.receipts.set(key, structuredClone(receipt));
      for (const [id, namespace] of Object.entries(receipt.nativeNamespaces)) {
        state.namespaces.set(id, structuredClone(namespace));
      }
      for (const [source, fact] of Object.entries(receipt.nativeArtifacts)) {
        state.files.set(source, { ...fact });
      }
    }
  }
}
