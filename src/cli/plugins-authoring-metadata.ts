import path from "node:path";
import { jsonSchemaValuesEqual } from "@openclaw/normalization-core/json-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { ToolPluginMetadata } from "../plugin-sdk/tool-plugin.js";
import { listBuiltRuntimeEntryCandidates } from "../plugins/package-entrypoints.js";
import { resolvePackageExtensionEntries } from "../plugins/package-manifest.js";

type JsonObject = Record<string, unknown>;

export function buildToolPluginManifest(params: {
  metadata: ToolPluginMetadata;
  packageManifest: JsonObject;
  existingManifest?: JsonObject;
}): JsonObject {
  const existingToolMetadata = isRecord(params.existingManifest?.toolMetadata)
    ? params.existingManifest.toolMetadata
    : {};
  const nextEntries = params.metadata.tools
    .map((tool) => {
      const existingValue = existingToolMetadata[tool.name];
      const existing = isRecord(existingValue) ? { ...existingValue } : {};
      if (tool.optional) {
        existing.optional = true;
      } else {
        delete existing.optional;
      }
      return [tool.name, existing] as const;
    })
    .filter(([, value]) => Object.keys(value).length > 0);
  const toolMetadata = nextEntries.length > 0 ? Object.fromEntries(nextEntries) : undefined;
  const existingContracts = isRecord(params.existingManifest?.contracts)
    ? params.existingManifest.contracts
    : {};
  const {
    contracts: _existingContracts,
    toolMetadata: _existingToolMetadata,
    ...existingManifestFields
  } = params.existingManifest ?? {};
  const manifest: JsonObject = {
    ...existingManifestFields,
    id: params.metadata.id,
    name: params.metadata.name,
    description: params.metadata.description,
    version:
      typeof params.packageManifest.version === "string" ? params.packageManifest.version : "0.0.0",
    configSchema: params.metadata.configSchema,
    activation: params.metadata.activation,
    contracts: {
      ...existingContracts,
      tools: params.metadata.tools.map((tool) => tool.name),
    },
    ...(toolMetadata ? { toolMetadata } : {}),
  };
  // Runtime schema options can contain undefined fields that the manifest writer drops.
  const serialized = JSON.stringify(manifest);
  // SAFETY: Serializing this assembled manifest preserves its outer JSON object shape.
  return JSON.parse(serialized) as JsonObject;
}

export function buildToolPluginPackageManifest(params: {
  packageManifest: JsonObject;
  entry: string;
}): JsonObject {
  const openclaw = isRecord(params.packageManifest.openclaw) ? params.packageManifest.openclaw : {};
  const extensions = filterStringEntries(openclaw.extensions);
  const selected = path.posix.normalize(params.entry);
  const matchesSelected = (entry: string) => path.posix.normalize(entry) === selected;
  const runtimeExtensions = Array.isArray(openclaw.runtimeExtensions)
    ? openclaw.runtimeExtensions
    : [];
  let index = extensions.findIndex(matchesSelected);
  if (index < 0) {
    index = runtimeExtensions.findIndex(
      (entry) => typeof entry === "string" && matchesSelected(entry),
    );
  }
  if (index < 0) {
    // Reverse selection follows runtime candidate precedence, not declaration order.
    for (const candidate of listBuiltRuntimeEntryCandidates(params.entry)) {
      index = extensions.findIndex(
        (entry) => path.posix.normalize(entry) === path.posix.normalize(candidate),
      );
      if (index >= 0) {
        break;
      }
    }
  }
  if (index < 0) {
    // Explicit positional mappings override inferred output paths for source entries.
    index = extensions.findIndex(
      (entry, entryIndex) =>
        !runtimeExtensions[entryIndex] &&
        listBuiltRuntimeEntryCandidates(entry).some(matchesSelected),
    );
  }
  if (index < 0) {
    extensions.push(params.entry);
  } else {
    extensions[index] = params.entry;
  }
  return {
    ...params.packageManifest,
    openclaw: {
      ...openclaw,
      extensions,
    },
  };
}

export function validateToolPluginProject(params: {
  metadata: ToolPluginMetadata;
  manifest: JsonObject;
  packageManifest: JsonObject;
  entry: string;
}): string[] {
  const errors: string[] = [];
  const expectedManifest = buildToolPluginManifest({
    metadata: params.metadata,
    packageManifest: params.packageManifest,
    existingManifest: params.manifest,
  });
  if (!jsonSchemaValuesEqual(params.manifest, expectedManifest)) {
    errors.push("openclaw.plugin.json generated metadata is stale. Run openclaw plugins build.");
  }
  if (params.manifest.id !== params.metadata.id) {
    errors.push(
      `openclaw.plugin.json id (${String(params.manifest.id)}) must match entry id (${params.metadata.id})`,
    );
  }
  if (!params.manifest.configSchema || typeof params.manifest.configSchema !== "object") {
    errors.push("openclaw.plugin.json must include object configSchema");
  }
  const manifestTools = filterStringEntries(
    isRecord(params.manifest.contracts) ? params.manifest.contracts.tools : undefined,
  );
  const metadataTools = params.metadata.tools.map((tool) => tool.name);
  const missing = metadataTools.filter((tool) => !manifestTools.includes(tool));
  const extra = manifestTools.filter((tool) => !metadataTools.includes(tool));
  if (missing.length > 0) {
    errors.push(`openclaw.plugin.json contracts.tools is missing: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    errors.push(
      `openclaw.plugin.json contracts.tools has no matching defineToolPlugin tool: ${extra.join(
        ", ",
      )}`,
    );
  }
  const extensionResolution = resolvePackageExtensionEntries(params.packageManifest);
  if (extensionResolution.status !== "ok") {
    errors.push(
      extensionResolution.status === "missing" || extensionResolution.status === "empty"
        ? "package.json must include openclaw.extensions"
        : extensionResolution.error,
    );
  } else if (!extensionResolution.entries.includes(params.entry)) {
    errors.push(`package.json openclaw.extensions must include ${params.entry}`);
  }
  return errors;
}

export function createConfigSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
}
