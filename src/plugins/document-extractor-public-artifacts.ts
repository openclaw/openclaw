// Extracts document extractor public artifacts from plugin manifests.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  DocumentExtractorPlugin,
  PluginDocumentExtractorEntry,
} from "./document-extractor-types.js";
import {
  loadBundledPublicArtifactEntries,
  type BundledPublicArtifactParams,
} from "./public-artifact-factories.js";

function isDocumentExtractorPlugin(value: unknown): value is DocumentExtractorPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    Array.isArray(value.mimeTypes) &&
    value.mimeTypes.every((mimeType) => typeof mimeType === "string" && mimeType.trim()) &&
    (value.autoDetectOrder === undefined || typeof value.autoDetectOrder === "number") &&
    typeof value.extract === "function"
  );
}

/** Loads document extractor entries from a bundled plugin public artifact module. */
export function loadBundledDocumentExtractorEntriesFromDir(
  params: BundledPublicArtifactParams,
): PluginDocumentExtractorEntry[] | null {
  return loadBundledPublicArtifactEntries({
    ...params,
    artifactCandidates: ["document-extractor.js", "document-extractor-api.js"],
    suffix: "DocumentExtractor",
    isArtifact: isDocumentExtractorPlugin,
    partialFailureLabel: "document extractors",
  });
}
