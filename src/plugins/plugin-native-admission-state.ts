import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isPathInside } from "../infra/path-guards.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { resolveActivePluginInstallRoots } from "./install-root-context.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
} from "./installed-plugin-index-types.js";
import { resolveRetainedManagedNpmInstallPackageInfo } from "./managed-npm-retention.js";
import { safeRealpathSync } from "./path-safety.js";
import type {
  InspectionNativeEsmPolicy,
  InspectionNativeEsmRetention,
} from "./plugin-cache-artifacts.js";
import { getPluginCache } from "./plugin-cache.js";
import type { PluginCache } from "./plugin-cache.types.js";
import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
import { resolvePluginMetadataEnvFingerprint } from "./plugin-metadata-env.js";
import type { PluginNativeCaptureRoot as NativeSnapshot } from "./plugin-native-root.types.js";
import type {
  PluginNativeArtifactFact,
  PluginNativeNamespaceFact,
  PluginSourceAdmissionPublication,
  PluginSourceAdmissionReceipt,
} from "./plugin-source-admission.types.js";
import { resolvePluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import {
  createPluginNativeCaptureRoot,
  retainPluginNativeCapturePath,
} from "./plugin-source-capture-directory.js";

export type AdmissionState = {
  readonly viewKey: string;
  readonly captureStorage: PluginSourceCaptureStorage;
  readonly publicationStateDir: string;
  readonly artifactPreservingReadOnly: boolean;
  createRoot(): NativeSnapshot;
  preparedIndexes: WeakSet<InstalledPluginIndex>;
  owners: Map<
    string,
    Pick<
      InstalledPluginIndexRecord,
      "pluginId" | "rootDir" | "installRecordHash" | "source" | "setupSource"
    >
  >;
  managedRoots: Map<string, "retained-npm" | "installed">;
  receipts: Map<string, PluginSourceAdmissionReceipt>;
  receiptInventoryComplete: boolean;
  files: Map<string, PluginNativeArtifactFact>;
  namespaces: Map<string, PluginNativeNamespaceFact>;
  pins: Map<string, () => void>;
  roots: Set<NativeSnapshot>;
  pending: Set<Promise<void>>;
  publications: Map<string, { data: PluginSourceAdmissionPublication; run(): Promise<void> }>;
  publishing: Set<string>;
  borrowers: Set<object>;
  inspectionNativeEsm?: InspectionNativeEsmRetention;
};
const admissions = new WeakMap<PluginCache, Map<string, AdmissionState>>();
const admissionScopes = new WeakMap<PluginCache, Set<AdmissionState>>();
export const snapshotOwners = new WeakMap<NativeSnapshot, Set<object>>();

/** Publication bounds reusable code to the installed entries and configured workspaces. */
export function publishInspectionNativeEsmPolicy(
  cache: PluginCache,
  policy: InspectionNativeEsmPolicy,
): void {
  const prepared = (cache.inspectionNativeEsmPolicy ??= {
    ...policy,
    viewKeys: new Set([resolveAdmissionViewKey(false), resolveAdmissionViewKey(true)]),
  });
  for (const state of admissions.get(cache)?.values() ?? []) {
    if (prepared.viewKeys.has(state.viewKey)) {
      state.inspectionNativeEsm ??= { ...prepared };
    }
  }
}

export type PluginNativeAdmissionTransfer = {
  receipts: Map<string, PluginSourceAdmissionReceipt>;
  roots: NativeSnapshot[];
  publications: PluginSourceAdmissionPublication[];
};

/** Adopt worker facts into the original admission view with independent root custody. */
export function adoptPluginNativeAdmissions(
  state: AdmissionState,
  transfer: PluginNativeAdmissionTransfer,
  publish?: (publication: PluginSourceAdmissionPublication) => Promise<boolean>,
): void {
  for (const root of transfer.roots) {
    snapshotOwners.set(root, new Set([state]));
    state.roots.add(root);
  }
  for (const [key, receipt] of transfer.receipts) {
    const replaced = state.receipts.get(key);
    state.receipts.set(key, receipt);
    for (const [source, fact] of Object.entries(receipt.nativeArtifacts)) {
      state.files.set(source, fact);
      retainNativePath(state, fact.capturedPath);
    }
    for (const [directory, namespace] of Object.entries(receipt.nativeNamespaces)) {
      state.namespaces.set(directory, namespace);
      retainNativePath(state, path.join(directory, "content"));
    }
    releaseReplacedNamespaces(state, replaced);
  }
  if (publish) {
    for (const publication of transfer.publications) {
      queuePluginNativeAdmissionPublication(state, publication, publish);
    }
  }
}

/** Return a detached receipt only when the live generation has new facts to publish. */
export function updatePluginNativeAdmissionReceipt(
  state: AdmissionState,
  key: string,
  proposed: PluginSourceAdmissionReceipt,
): PluginSourceAdmissionReceipt | undefined {
  const replaced = state.receipts.get(key);
  // A pending publication already owns a detached receipt. Otherwise preserve the
  // clone-before-compare boundary, including normalization of caller-owned prototypes.
  if (
    replaced &&
    state.publications.get(key)?.data.receipt === replaced &&
    isDeepStrictEqual(replaced, proposed)
  ) {
    return undefined;
  }
  const next = structuredClone(proposed);
  if (isDeepStrictEqual(replaced, next)) {
    return undefined;
  }
  state.receipts.set(key, next);
  releaseReplacedNamespaces(state, replaced);
  return next;
}

/** A replaced receipt retires unreferenced file facts before pruning namespace maps. */
function releaseReplacedNamespaces(
  state: AdmissionState,
  replaced: PluginSourceAdmissionReceipt | undefined,
): void {
  if (state.receiptInventoryComplete) {
    for (const source of Object.keys(replaced?.nativeArtifacts ?? {})) {
      if (![...state.receipts.values()].some((receipt) => source in receipt.nativeArtifacts)) {
        state.files.delete(source);
      }
    }
  }
  for (const id of Object.keys(replaced?.nativeNamespaces ?? {})) {
    if (
      ![...state.receipts.values()].some((receipt) => id in receipt.nativeNamespaces) &&
      ![...state.files.values()].some((file) => file.namespace === id)
    ) {
      state.namespaces.delete(id);
    }
  }
}

function resolveAdmissionViewKey(
  readOnly = isArtifactPreservingStateRead(),
  storage = resolvePluginSourceCaptureStorage(),
  publicationStateDir = resolveActivePluginInstallRoots().stateDir,
): string {
  return JSON.stringify([
    readOnly ? "readonly" : "writable",
    resolvePluginMetadataEnvFingerprint(),
    storage.stateDir,
    storage.placement,
    publicationStateDir,
  ]);
}

export function retainNativePath(state: AdmissionState, filename: string): void {
  if (!state.pins.has(filename)) {
    state.pins.set(filename, retainPluginNativeCapturePath(filename));
  }
}

export async function settlePluginNativeAdmissions(cache = getPluginCache()): Promise<void> {
  for (const state of admissions.get(cache)?.values() ?? []) {
    await settlePluginNativeAdmissionState(state);
  }
}

export async function settlePluginNativeAdmissionState(state: AdmissionState): Promise<void> {
  await Promise.all(state.pending);
  // Explicit settlement also drains a newer receipt queued behind an earlier write.
  for (const key of state.publications.keys()) {
    startNativeAdmissionPublication(state, key);
  }
  await Promise.all(state.pending);
}

/** Publication intent belongs to admission custody, independently of source execution. */
export function queuePluginNativeAdmissionPublication(
  state: AdmissionState,
  data: PluginSourceAdmissionPublication,
  publish: (publication: PluginSourceAdmissionPublication) => Promise<boolean>,
): void {
  const roots = [...state.roots].filter((root) => data.receipt.nativeNamespaces[root.directory]);
  const publication = {
    data,
    run: () =>
      publish(data)
        .then(async (accepted) => {
          if (accepted) {
            await Promise.all(roots.map(async (root) => root.commit()));
            if (state.publications.get(data.key) === publication) {
              state.publications.delete(data.key);
            }
          }
        })
        .catch((error: unknown) =>
          process.emitWarning(`Plugin source receipt was not recorded: ${String(error)}`),
        ),
  };
  state.publications.set(data.key, publication);
  startNativeAdmissionPublication(state, data.key);
}

export function startNativeAdmissionPublication(state: AdmissionState, key: string): void {
  const publish = state.publications.get(key);
  if (!publish || state.publishing.has(key)) {
    return;
  }
  state.publishing.add(key);
  const pending = publish.run().finally(() => {
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
          await owned.inspectionNativeEsm?.dispose?.();
          await settlePluginNativeAdmissionState(owned);
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
  let views = admissions.get(cache);
  if (!views) {
    views = new Map();
    admissions.set(cache, views);
  }
  views.set(state.viewKey, state);
  return state;
}

export function nativeAdmissionStateFor(cache = getPluginCache()): AdmissionState {
  const artifactPreservingReadOnly = isArtifactPreservingStateRead();
  const captureStorage = resolvePluginSourceCaptureStorage();
  const publicationStateDir = resolveActivePluginInstallRoots().stateDir;
  const viewKey = resolveAdmissionViewKey(
    artifactPreservingReadOnly,
    captureStorage,
    publicationStateDir,
  );
  const state = admissions.get(cache)?.get(viewKey);
  return (
    state ??
    bindAdmissionState(cache, {
      viewKey,
      // Deferred publication and disposal can run after the caller restores its environment.
      captureStorage,
      publicationStateDir,
      artifactPreservingReadOnly,
      createRoot: () =>
        createPluginNativeCaptureRoot(captureStorage.stateDir, captureStorage.placement),
      preparedIndexes: new WeakSet(),
      owners: new Map(),
      managedRoots: new Map(),
      receipts: new Map(),
      receiptInventoryComplete: true,
      files: new Map(),
      namespaces: new Map(),
      pins: new Map(),
      roots: new Set(),
      pending: new Set(),
      publications: new Map(),
      publishing: new Set(),
      borrowers: new Set(),
      inspectionNativeEsm: cache.inspectionNativeEsmPolicy?.viewKeys.has(viewKey)
        ? { ...cache.inspectionNativeEsmPolicy }
        : undefined,
    })
  );
}

/** Inspections in the same state view share payload custody, never registration authority. */
export function inheritPluginNativeAdmissions(
  sourceCache: PluginCache,
  targetCache: PluginCache,
): void {
  if (sourceCache !== targetCache) {
    targetCache.inspectionNativeEsmPolicy = sourceCache.inspectionNativeEsmPolicy;
    bindAdmissionState(targetCache, nativeAdmissionStateFor(sourceCache));
  }
}

/** Carry prepared receipts to workers without mutating the published metadata snapshot. */
export function overlayPluginNativeAdmissions(
  index: InstalledPluginIndex,
  cache: PluginCache,
): InstalledPluginIndex {
  const state = admissions.get(cache)?.get(resolveAdmissionViewKey());
  if (!state || state.receipts.size === 0) {
    return index;
  }
  // A filtered registry can share a wider cache. Only materialize receipts for its roots.
  const receiptsByRoot = new Map<
    string,
    Record<string, PluginSourceAdmissionReceipt> | undefined
  >();
  const roots = index.plugins.map((record) => {
    const root = path.resolve(record.rootDir);
    receiptsByRoot.set(root, undefined);
    return root;
  });
  for (const [key, receipt] of state.receipts) {
    // The producer keeps the entry suffix opaque, including any further separators.
    const separator = key.indexOf("\0");
    if (separator < 0) {
      continue;
    }
    const root = key.slice(0, separator);
    const group = receiptsByRoot.get(root);
    if (group) {
      group[key] = receipt;
    } else if (receiptsByRoot.has(root)) {
      receiptsByRoot.set(root, { [key]: receipt });
    }
  }
  return {
    ...index,
    plugins: index.plugins.map((record, position) => {
      const receipts = receiptsByRoot.get(roots[position]!);
      return receipts
        ? { ...record, sourceAdmissions: { ...record.sourceAdmissions, ...receipts } }
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
  if (state.preparedIndexes.has(index)) {
    return;
  }
  const immutable = isDeeplyFrozenPlainData(index);
  for (const record of index.plugins) {
    const root = path.resolve(record.rootDir);
    if (state.owners.has(root)) {
      continue;
    }
    // Admission needs source and publication identity, not the inventory's catalogs or receipts.
    state.owners.set(root, {
      pluginId: record.pluginId,
      rootDir: record.rootDir,
      installRecordHash: record.installRecordHash,
      source: record.source,
      setupSource: record.setupSource,
    });
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
      state.receipts.set(key, receipt);
      for (const [id, namespace] of Object.entries(receipt.nativeNamespaces)) {
        // Retain published membership until a native admission needs writable identities.
        state.namespaces.set(id, immutable ? { ...namespace } : structuredClone(namespace));
      }
      for (const [source, fact] of Object.entries(receipt.nativeArtifacts)) {
        state.files.set(source, { ...fact });
      }
    }
  }
  if (immutable) {
    state.preparedIndexes.add(index);
  }
}
