// Manual facade. Keep loader boundary explicit.
import path from "node:path";
import { createConfiguredProviderLocalServiceAcquirer } from "../agents/provider-local-service.js";
import { getRuntimeConfig } from "../config/config.js";
import type {
  DreamingArtifactsAuditSummary,
  RepairDreamingArtifactsResult,
  RepairShortTermPromotionArtifactsResult,
  ShortTermAuditSummary,
  ShortTermDreamingStats,
} from "../memory-host-sdk/dreaming.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import type { PluginStateOperationModuleSource } from "../plugin-state/plugin-state-store.native-binding.js";
import { isTypeScriptPackageEntry } from "../plugins/package-entrypoints.js";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import { capturePluginStateOperationModuleSource } from "../plugins/plugin-state-operation-source.js";
// Memory core bundled runtime helpers load the internal memory plugin through SDK facades.
import {
  loadBundledPluginPublicSurfaceModuleSyncCore,
  resolveBundledPublicSurfaceLocation,
} from "./facade-loader.js";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderRuntime,
} from "./memory-core-host-engine-embeddings.js";
import type { OpenKeyedStoreOptions, PluginStateKeyedStore } from "./plugin-state-runtime.js";

type EmbeddingProviderResult = {
  provider: MemoryEmbeddingProvider | null;
  requestedProvider: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  runtime?: MemoryEmbeddingProviderRuntime;
};

export type { DreamingArtifactsAuditSummary, ShortTermAuditSummary };

type RuntimeFacadeModule = {
  configureMemoryCoreDreamingState: (
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
  ) => void;
  createEmbeddingProvider: (
    options: Omit<MemoryEmbeddingProviderCreateOptions, "dimensions"> & {
      provider: string;
      fallback: string;
      outputDimensionality?: number;
    },
  ) => Promise<EmbeddingProviderResult>;
  removeGroundedShortTermCandidates: (params: {
    workspaceDir: string;
  }) => Promise<{ removed: number; storePath: string }>;
  loadShortTermPromotionDreamingStats: (params: {
    workspaceDir: string;
    nowMs: number;
    timezone?: string;
  }) => Promise<ShortTermDreamingStats>;
  auditDreamingArtifacts: (params: {
    workspaceDir: string;
  }) => Promise<DreamingArtifactsAuditSummary>;
  auditShortTermPromotionArtifacts: (params: {
    workspaceDir: string;
  }) => Promise<ShortTermAuditSummary>;
  repairDreamingArtifacts: (params: {
    workspaceDir: string;
    archiveDiary?: boolean;
    now?: Date;
  }) => Promise<RepairDreamingArtifactsResult>;
  repairShortTermPromotionArtifacts: (params: {
    workspaceDir: string;
  }) => Promise<RepairShortTermPromotionArtifactsResult>;
};

type GroundedRemPreviewItem = {
  text: string;
  refs: string[];
};

type GroundedRemCandidate = GroundedRemPreviewItem & {
  lean: "likely_durable" | "unclear" | "likely_situational";
};

type GroundedRemFilePreview = {
  path: string;
  facts: GroundedRemPreviewItem[];
  reflections: GroundedRemPreviewItem[];
  memoryImplications: GroundedRemPreviewItem[];
  candidates: GroundedRemCandidate[];
  renderedMarkdown: string;
};

type GroundedRemPreviewResult = {
  workspaceDir: string;
  scannedFiles: number;
  files: GroundedRemFilePreview[];
};

type ApiFacadeModule = {
  MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE: string;
  configureMemoryCoreDreamingState: (
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
  ) => void;
  previewGroundedRemMarkdown: (params: {
    workspaceDir: string;
    inputPaths: string[];
  }) => Promise<GroundedRemPreviewResult>;
  dedupeDreamDiaryEntries: (params: {
    workspaceDir: string;
  }) => Promise<{ dreamsPath: string; removed: number; kept: number }>;
  writeBackfillDiaryEntries: (params: {
    workspaceDir: string;
    entries: Array<{
      isoDay: string;
      bodyLines: string[];
      sourcePath?: string;
    }>;
    timezone?: string;
  }) => Promise<{ dreamsPath: string; written: number; replaced: number }>;
  removeBackfillDiaryEntries: (params: {
    workspaceDir: string;
  }) => Promise<{ dreamsPath: string; removed: number }>;
};

type FacadeModules = {
  "api.js": ApiFacadeModule;
  "runtime-api.js": RuntimeFacadeModule;
};

function loadFacadeModule<Artifact extends keyof FacadeModules>(
  artifactBasename: Artifact,
): FacadeModules[Artifact] {
  const module = loadBundledPluginPublicSurfaceModuleSyncCore<FacadeModules[Artifact]>({
    dirName: "memory-core",
    artifactBasename,
  });
  const instance = getPluginValueInstance(module);
  const assertCurrent = instance ? () => instance.run(() => {}) : undefined;
  let moduleSource: PluginStateOperationModuleSource | undefined;
  if (instance && assertCurrent) {
    moduleSource = capturePluginStateOperationModuleSource(instance, assertCurrent);
  } else {
    // CLI facades have process-stable code; capture their selected family before yielding.
    const facade = resolveBundledPublicSurfaceLocation({
      dirName: "memory-core",
      artifactBasename,
    });
    const operation = resolveBundledPublicSurfaceLocation({
      dirName: "memory-core",
      artifactBasename: "recall-operation-api.js",
    });
    const operationModule =
      facade?.origin === "bundled" &&
      operation?.origin === "bundled" &&
      path.dirname(facade.modulePath) === path.dirname(operation.modulePath) &&
      isTypeScriptPackageEntry(facade.modulePath) === isTypeScriptPackageEntry(operation.modulePath)
        ? { ...operation, pluginId: "memory-core", origin: "bundled" as const }
        : undefined;
    moduleSource = {
      resolve(moduleName) {
        if (moduleName !== "recall-operation-api.js" || !operationModule) {
          throw new Error("Memory recall operation is absent from its selected facade family");
        }
        return operationModule;
      },
    };
  }
  module.configureMemoryCoreDreamingState(<Value>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStore<Value>("memory-core", options, assertCurrent, moduleSource),
  );
  return module;
}

const loadApiFacadeModule = () => loadFacadeModule("api.js");
const loadRuntimeFacadeModule = () => loadFacadeModule("runtime-api.js");

/** Returns the memory-core-owned recovery message for an absent local provider plugin. */
export function getMissingLocalMemoryEmbeddingProviderMessage(): string {
  return loadApiFacadeModule().MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE;
}

const acquireLocalService = createConfiguredProviderLocalServiceAcquirer(getRuntimeConfig);

/** Create a memory embedding provider with built-in fallback metadata. */
export const createEmbeddingProvider: RuntimeFacadeModule["createEmbeddingProvider"] = (
  options,
) => {
  const createOptions = {
    ...options,
    acquireLocalService,
  };
  return loadRuntimeFacadeModule().createEmbeddingProvider(createOptions);
};

/** Remove short-term recall candidates already grounded into durable memory. */
export const removeGroundedShortTermCandidates: RuntimeFacadeModule["removeGroundedShortTermCandidates"] =
  (...args) => loadRuntimeFacadeModule().removeGroundedShortTermCandidates(...args);
/** Load short-term dreaming stats for doctor/control status. */
export const loadShortTermPromotionDreamingStats: RuntimeFacadeModule["loadShortTermPromotionDreamingStats"] =
  (...args) => loadRuntimeFacadeModule().loadShortTermPromotionDreamingStats(...args);
/** Audit dreaming diary and session-corpus artifacts through the bundled runtime facade. */
export const auditDreamingArtifacts: RuntimeFacadeModule["auditDreamingArtifacts"] = (...args) =>
  loadRuntimeFacadeModule().auditDreamingArtifacts(...args);
/** Audit short-term promotion artifacts through the bundled runtime facade. */
export const auditShortTermPromotionArtifacts: RuntimeFacadeModule["auditShortTermPromotionArtifacts"] =
  (...args) => loadRuntimeFacadeModule().auditShortTermPromotionArtifacts(...args);
/** Repair or archive problematic dreaming artifacts through the bundled runtime facade. */
export const repairDreamingArtifacts: RuntimeFacadeModule["repairDreamingArtifacts"] = (...args) =>
  loadRuntimeFacadeModule().repairDreamingArtifacts(...args);
/** Repair short-term promotion artifacts through the bundled runtime facade. */
export const repairShortTermPromotionArtifacts: RuntimeFacadeModule["repairShortTermPromotionArtifacts"] =
  (...args) => loadRuntimeFacadeModule().repairShortTermPromotionArtifacts(...args);

/** Preview grounded REM markdown facts and candidates for selected input files. */
export const previewGroundedRemMarkdown: ApiFacadeModule["previewGroundedRemMarkdown"] = (
  ...args
) => loadApiFacadeModule().previewGroundedRemMarkdown(...args);

/** Remove duplicate dreaming diary entries while preserving canonical records. */
export const dedupeDreamDiaryEntries: ApiFacadeModule["dedupeDreamDiaryEntries"] = (...args) =>
  loadApiFacadeModule().dedupeDreamDiaryEntries(...args);

/** Write synthetic/backfill dreaming diary entries for harness or migration use. */
export const writeBackfillDiaryEntries: ApiFacadeModule["writeBackfillDiaryEntries"] = (...args) =>
  loadApiFacadeModule().writeBackfillDiaryEntries(...args);

/** Remove dreaming diary entries previously written by the backfill helper. */
export const removeBackfillDiaryEntries: ApiFacadeModule["removeBackfillDiaryEntries"] = (
  ...args
) => loadApiFacadeModule().removeBackfillDiaryEntries(...args);
