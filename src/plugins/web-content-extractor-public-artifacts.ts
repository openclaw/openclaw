import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
import type {
  PluginWebContentExtractorEntry,
  WebContentExtractorPlugin,
} from "./web-content-extractor-types.js";

const WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES = [
  "web-content-extractor.js",
  "web-content-extractor-api.js",
] as const;

function normalizeWebContentExtractorPlugin(value: unknown): WebContentExtractorPlugin | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value.id;
  const label = value.label;
  const autoDetectOrder = value.autoDetectOrder;
  const extract = value.extract;
  if (
    typeof id !== "string" ||
    typeof label !== "string" ||
    (autoDetectOrder !== undefined && typeof autoDetectOrder !== "number") ||
    typeof extract !== "function"
  ) {
    return null;
  }
  return {
    id,
    label,
    ...(autoDetectOrder === undefined ? {} : { autoDetectOrder }),
    extract,
  };
}

function tryLoadBundledPublicArtifactModule(params: {
  dirName: string;
}): Record<string, unknown> | null {
  for (const artifactBasename of WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES) {
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
  extractors: WebContentExtractorPlugin[];
  errors: unknown[];
} {
  const extractors: WebContentExtractorPlugin[] = [];
  const errors: unknown[] = [];
  for (const [name, exported] of Object.entries(mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith("WebContentExtractor")
    ) {
      continue;
    }
    try {
      const candidate = exported();
      const extractor = normalizeWebContentExtractorPlugin(candidate);
      if (extractor) {
        extractors.push(extractor);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return { extractors, errors };
}

export function loadBundledWebContentExtractorEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebContentExtractorEntry[] | null {
  const mod = tryLoadBundledPublicArtifactModule({ dirName: params.dirName });
  if (!mod) {
    return null;
  }
  const { extractors, errors } = collectExtractorFactories(mod);
  if (extractors.length === 0) {
    if (errors.length > 0) {
      throw new Error(`Unable to initialize web content extractors for plugin ${params.pluginId}`, {
        cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
      });
    }
    return null;
  }
  return extractors.map((extractor) => Object.assign({}, extractor, { pluginId: params.pluginId }));
}
