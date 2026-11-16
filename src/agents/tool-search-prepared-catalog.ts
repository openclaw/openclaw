import { getPublishedRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { freezeTrustedJsonSnapshot } from "../shared/immutable-data.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

export type ToolSearchCatalogDescriptor = Readonly<Omit<ToolSearchCatalogEntry, "tool">>;

type PreparedCatalog = {
  descriptors: readonly ToolSearchCatalogDescriptor[];
  prompts: Map<string, string>;
  chars: number;
};

// Only detached data survives a run. Executors, policy bindings and hook contexts
// remain in the run's entries and are released by clearToolSearchCatalog.
const preparedCatalogs = new Map<string, PreparedCatalog>();
const entryCatalogs = new WeakMap<readonly ToolSearchCatalogEntry[], PreparedCatalog>();
const MAX_CATALOGS = 32;
const MAX_CATALOG_CHARS = 1024 * 1024;
const MAX_PREPARED_CHARS = 4 * 1024 * 1024;
let preparedChars = 0;

export function prepareToolSearchCatalogDescriptors(entries: readonly ToolSearchCatalogEntry[]): {
  prepared: PreparedCatalog;
  reused: boolean;
} {
  const existing = entryCatalogs.get(entries);
  if (existing) {
    return { prepared: existing, reused: true };
  }
  let shareable = true;
  let schemaChars = 0;
  const encoded = entries.map(({ tool: _tool, parameters, outputSchema, ...descriptor }) => {
    const schemaJson = (schema: unknown) => {
      // Client projections advertise unknown inputs and no output schema. Their
      // actual schema belongs exclusively to the current run's describe/call path.
      if (schema === undefined || descriptor.source === "client") {
        return undefined;
      }
      const published = getPublishedRuntimeToolInputSchema(schema);
      if (published) {
        schemaChars += published.json.length;
        return { fingerprint: published.fingerprint, json: published.json };
      }
      // Unpublished remote schemas can be lazy/hostile. Their owner must publish
      // a detached schema before cross-run reuse; registration never traverses them.
      if (descriptor.source !== "openclaw") {
        shareable = false;
        return undefined;
      }
      const json = JSON.stringify(schema);
      schemaChars += json?.length ?? 0;
      return { fingerprint: sha256Hex(json), json };
    };
    return {
      descriptor: [
        descriptor.id,
        descriptor.source,
        descriptor.sourceName,
        descriptor.name,
        descriptor.label,
        descriptor.description,
        descriptor.directVisible === true,
        descriptor.requiresExactId === true,
        descriptor.mcp ? stableStringify(descriptor.mcp) : undefined,
      ] as const,
      parameters: schemaJson(parameters),
      outputSchema: schemaJson(outputSchema),
    };
  });
  // Registration has already sorted unique ids and finalized policy/model-derived
  // descriptors. Schema property order is preserved because declaration bytes use it.
  const key = shareable
    ? JSON.stringify(
        encoded.map(({ descriptor, parameters, outputSchema }) => [
          descriptor,
          parameters?.fingerprint,
          outputSchema?.fingerprint,
        ]),
      )
    : undefined;
  const cached = key === undefined ? undefined : preparedCatalogs.get(key);
  if (cached && key !== undefined) {
    preparedCatalogs.delete(key);
    preparedCatalogs.set(key, cached);
    entryCatalogs.set(entries, cached);
    return { prepared: cached, reused: true };
  }
  const prepared: PreparedCatalog = {
    descriptors: entries.map(({ tool: _tool, ...descriptor }) =>
      descriptor.source === "client"
        ? { ...descriptor, parameters: undefined, outputSchema: undefined }
        : descriptor,
    ),
    prompts: new Map(),
    chars: (key?.length ?? 0) + schemaChars,
  };
  if (key !== undefined && key.length + schemaChars <= MAX_CATALOG_CHARS) {
    // Published schemas are already detached and immutable. Only mutable native
    // inputs need a snapshot, decoded from the exact bytes used for comparison.
    const snapshotSchema = <T>(schema: T, json: string | undefined): T => {
      if (schema === undefined || getPublishedRuntimeToolInputSchema(schema)) {
        return schema;
      }
      // SAFETY: json encodes this native schema's JSON descriptor above.
      return freezeTrustedJsonSnapshot(JSON.parse(json!) as T);
    };
    prepared.descriptors = Object.freeze(
      prepared.descriptors.map((descriptor, index) =>
        Object.freeze({
          ...descriptor,
          parameters: snapshotSchema(descriptor.parameters, encoded[index]!.parameters?.json),
          outputSchema: snapshotSchema(descriptor.outputSchema, encoded[index]!.outputSchema?.json),
          // The key's stableStringify keeps `undefined` members, which are not JSON;
          // snapshot MCP metadata through JSON, which drops them.
          ...(descriptor.mcp
            ? { mcp: freezeTrustedJsonSnapshot(JSON.parse(JSON.stringify(descriptor.mcp))) }
            : {}),
        }),
      ),
    );
    preparedCatalogs.set(key, prepared);
    preparedChars += prepared.chars;
    while (preparedCatalogs.size > MAX_CATALOGS || preparedChars > MAX_PREPARED_CHARS) {
      const [oldestKey, oldest] = preparedCatalogs.entries().next().value!;
      preparedChars -= oldest.chars;
      preparedCatalogs.delete(oldestKey);
    }
  }
  entryCatalogs.set(entries, prepared);
  return { prepared, reused: false };
}

export function getToolSearchCatalogDescriptors(entries: readonly ToolSearchCatalogEntry[]) {
  return prepareToolSearchCatalogDescriptors(entries).prepared;
}
