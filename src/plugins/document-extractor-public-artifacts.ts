import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  DocumentExtractorPlugin,
  PluginDocumentExtractorEntry,
} from "./document-extractor-types.js";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";

const DOCUMENT_EXTRACTOR_ARTIFACT_CANDIDATES = [
  "document-extractor.js",
  "document-extractor-api.js",
] as const;

function normalizeDocumentExtractorPlugin(value: unknown): DocumentExtractorPlugin | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value.id;
  const label = value.label;
  const mimeTypes = value.mimeTypes;
  const autoDetectOrder = value.autoDetectOrder;
  const extract = value.extract;
  if (
    typeof id !== "string" ||
    typeof label !== "string" ||
    !Array.isArray(mimeTypes) ||
    !mimeTypes.every((mimeType) => typeof mimeType === "string" && mimeType.trim()) ||
    (autoDetectOrder !== undefined && typeof autoDetectOrder !== "number") ||
    typeof extract !== "function"
  ) {
    return null;
  }
  return {
    id,
    label,
    mimeTypes,
    ...(autoDetectOrder === undefined ? {} : { autoDetectOrder }),
    extract,
  };
}

function tryLoadBundledPublicArtifactModule(params: {
  dirName: string;
}): Record<string, unknown> | null {
  for (const artifactBasename of DOCUMENT_EXTRACTOR_ARTIFACT_CANDIDATES) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: params.dirName,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function collectExtractorFactories(mod: Record<string, unknown>): {
  extractors: DocumentExtractorPlugin[];
  errors: unknown[];
} {
  const extractors: DocumentExtractorPlugin[] = [];
  const errors: unknown[] = [];
  for (const [name, exported] of Object.entries(mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith("DocumentExtractor")
    ) {
      continue;
    }
    try {
      const candidate = exported();
      const extractor = normalizeDocumentExtractorPlugin(candidate);
      if (extractor) {
        extractors.push(extractor);
      }
    } catch (error) {
      errors.push(error);
      continue;
    }
  }
  return { extractors, errors };
}

export function loadBundledDocumentExtractorEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginDocumentExtractorEntry[] | null {
  const mod = tryLoadBundledPublicArtifactModule({ dirName: params.dirName });
  if (!mod) {
    return null;
  }
  const { extractors, errors } = collectExtractorFactories(mod);
  if (extractors.length === 0) {
    if (errors.length > 0) {
      throw new Error(`Unable to initialize document extractors for plugin ${params.pluginId}`, {
        cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
      });
    }
    return null;
  }
  return extractors.map((extractor) => Object.assign({}, extractor, { pluginId: params.pluginId }));
}
