import type { GatewaySessionRow } from "../../api/types.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeDefaultMainSessionAliasForUi,
  parseAgentSessionKey,
} from "./session-key.ts";
import { isShallowEqualSessionRow } from "./session-row-equality.ts";
import { thinkingMetadataFields } from "./session-thinking-metadata.ts";

export type SessionRowFieldSelector = (
  projectedRow: GatewaySessionRow,
  fieldNames: readonly string[],
) => string[];

type FieldSource = Readonly<{
  revision: number;
  updatedAt: number | null;
  snapshotAt?: number;
  event?: true;
  readCutoff?: number;
}>;

export type FieldObservation = Readonly<{
  source: FieldSource;
  writer?: FieldSource;
}>;

export function createSessionWriteObservation(
  revision: number,
  updatedAt: number | null,
  readCutoff?: number,
  snapshotAt?: number,
): FieldObservation {
  return {
    source: {
      revision,
      updatedAt,
      event: true,
      ...(readCutoff !== undefined ? { readCutoff } : {}),
      ...(snapshotAt !== undefined ? { snapshotAt } : {}),
    },
  };
}

function isNewerSource(candidate: FieldSource, current: FieldSource) {
  // Event snapshots and cached list pages share the Gateway's sampling clock.
  // Request/delivery order and persisted updatedAt cannot order runtime-only changes.
  if (
    candidate.snapshotAt !== undefined &&
    current.snapshotAt !== undefined &&
    candidate.snapshotAt !== current.snapshotAt
  ) {
    return candidate.snapshotAt > current.snapshotAt;
  }
  if (
    (candidate.event || current.event) &&
    candidate.updatedAt !== null &&
    current.updatedAt !== null &&
    candidate.updatedAt !== current.updatedAt
  ) {
    return candidate.updatedAt > current.updatedAt;
  }
  if (!candidate.event && current.readCutoff !== undefined) {
    return candidate.revision > current.readCutoff;
  }
  if (!current.event && candidate.readCutoff !== undefined) {
    return current.revision <= candidate.readCutoff;
  }
  return candidate.revision > current.revision;
}

export function mergeSessionFieldObservations(
  current: FieldObservation | undefined,
  offered: FieldObservation,
): { useOffered: boolean; observation: FieldObservation } {
  let writer = current?.writer;
  if (offered.writer && (!writer || isNewerSource(offered.writer, writer))) {
    writer = offered.writer;
  }
  const supersededWriter = (source: FieldSource) =>
    Boolean(source.event && writer && source !== writer && isNewerSource(writer, source));
  const useOffered =
    !current ||
    (offered.source !== current.source &&
      (supersededWriter(current.source) ||
        (!supersededWriter(offered.source) && isNewerSource(offered.source, current.source))));
  const selected = current && !useOffered ? current : offered;
  // Only an admitted value source can add a writer; rejected late events cannot raise the fence.
  if (selected.source.event && (!writer || isNewerSource(selected.source, writer))) {
    writer = selected.source;
  }
  return {
    useOffered,
    observation: selected.writer === writer ? selected : { source: selected.source, writer },
  };
}

type RowObservation = {
  read: FieldObservation;
  agentId: string | null;
  fields: ReadonlyMap<string, FieldObservation>;
};

const donatedFields = ["derivedTitle", "lastMessagePreview", ...thinkingMetadataFields] as const;
const identityFields = new Set(["key", "sessionId", "agentId"]);

/** Field receipts follow row copies without retaining another store of row values. */
export function createSessionRowProvenance() {
  let observationsByRow = new WeakMap<GatewaySessionRow, RowObservation>();
  const completedSelfMerges = new WeakSet<RowObservation>();
  const owner = (row: GatewaySessionRow, agentId?: string | null) => {
    const resolved =
      parseAgentSessionKey(row.key)?.agentId ??
      row.agentId?.trim() ??
      observationsByRow.get(row)?.agentId ??
      agentId?.trim();
    return resolved ? normalizeAgentId(resolved) : null;
  };
  const identity = (row: GatewaySessionRow, agentId?: string | null) => {
    const resolvedAgent = owner(row, agentId);
    if (!row.sessionId?.trim() || (isUiGlobalSessionKey(row.key) && !resolvedAgent)) {
      return null;
    }
    return JSON.stringify([
      normalizeDefaultMainSessionAliasForUi(row.key),
      resolvedAgent,
      row.sessionId,
    ]);
  };
  const metadata = (row: GatewaySessionRow, agentId?: string | null): RowObservation =>
    observationsByRow.get(row) ?? {
      read: { source: { revision: 0, updatedAt: row.updatedAt ?? null } },
      agentId: owner(row, agentId),
      fields: new Map(),
    };
  const selectSourceFields = (
    row: GatewaySessionRow,
    source: FieldObservation,
    agentId?: string | null,
  ): SessionRowFieldSelector => {
    const key = identity(row, agentId);
    const generation = observationsByRow;
    // Merges can reuse the source row; the captured token still identifies its original facts.
    return (projectedRow, fieldNames) => {
      const projected = observationsByRow.get(projectedRow);
      if (
        !key ||
        generation !== observationsByRow ||
        !projected ||
        identity(projectedRow, agentId) !== key
      ) {
        return [];
      }
      return fieldNames.filter(
        (name) =>
          !identityFields.has(name) &&
          (projected.fields.get(name) ?? projected.read).source === source.source,
      );
    };
  };
  const observeReadRow = (
    row: GatewaySessionRow,
    revision: number,
    agentId?: string | null,
    predecessors: readonly GatewaySessionRow[] = [],
  ): SessionRowFieldSelector => {
    if ((observationsByRow.get(row)?.read.source.revision ?? 0) >= revision) {
      // A merge may have attached another read's token to this same row object.
      return () => [];
    }
    const writers = new Map<string, FieldSource>();
    for (const predecessor of predecessors) {
      for (const [name, observed] of metadata(predecessor, agentId).fields) {
        const writer = observed.writer;
        const previous = writers.get(name);
        if (writer && (!previous || isNewerSource(writer, previous))) {
          writers.set(name, writer);
        }
      }
    }
    const fields = new Map<string, FieldObservation>();
    // Only these optional fields are deliberately omitted by non-enriched reads.
    for (const field of ["derivedTitle", "lastMessagePreview"] as const) {
      if (row[field] === undefined) {
        fields.set(field, { source: { revision: 0, updatedAt: null } });
      }
    }
    const readAgentId =
      parseAgentSessionKey(row.key)?.agentId ?? row.agentId?.trim() ?? agentId?.trim();
    const read: FieldObservation = {
      source: { revision, updatedAt: row.updatedAt ?? null, snapshotAt: row.snapshotAt },
    };
    for (const [name, writer] of writers) {
      const source = (fields.get(name) ?? read).source;
      if (isNewerSource(source, writer)) {
        fields.set(name, { source, writer });
      }
    }
    observationsByRow.set(row, {
      read,
      agentId: readAgentId ? normalizeAgentId(readAgentId) : null,
      fields,
    });
    return selectSourceFields(row, read, agentId);
  };
  const inheritRow = (
    row: GatewaySessionRow,
    source: GatewaySessionRow | undefined,
    donor?: GatewaySessionRow,
  ) => {
    if (!source || observationsByRow.has(row)) {
      return row;
    }
    const sourceMetadata = metadata(source);
    const key = identity(source, sourceMetadata.agentId);
    if (!key || key !== identity(row, sourceMetadata.agentId)) {
      return row;
    }
    const fields = new Map(sourceMetadata.fields);
    if (donor && identity(donor) === key) {
      const donated = metadata(donor, sourceMetadata.agentId);
      for (const field of donatedFields) {
        if (row[field] !== source[field] && row[field] === donor[field]) {
          fields.set(field, donated.fields.get(field) ?? donated.read);
        }
      }
    }
    observationsByRow.set(row, { ...sourceMetadata, fields });
    return row;
  };
  const mergeRow = (
    current: GatewaySessionRow,
    offered: GatewaySessionRow,
    agentId?: string | null,
  ): GatewaySessionRow => {
    const observed = current === offered ? observationsByRow.get(current) : undefined;
    if (observed && completedSelfMerges.has(observed)) {
      return current;
    }
    const key = identity(current, agentId);
    if (!key || key !== identity(offered, agentId)) {
      return current;
    }
    const currentMetadata = observed ?? metadata(current, agentId);
    if (observed) {
      // Self-projection can admit event writers without changing any row values.
      let fields: Map<string, FieldObservation> | undefined;
      for (const [field, observation] of currentMetadata.fields) {
        const merged = mergeSessionFieldObservations(observation, observation).observation;
        if (merged !== observation) {
          fields ??= new Map(currentMetadata.fields);
          fields.set(field, merged);
        }
      }
      const settled = fields ? { ...currentMetadata, fields } : currentMetadata;
      if (fields) {
        observationsByRow.set(current, settled);
      }
      // Only completed, valid self-merges are reusable; every receipt writer replaces this record.
      completedSelfMerges.add(settled);
      return current;
    }
    const offeredMetadata = metadata(offered, agentId);
    // Keep the request high-water mark for late-descriptor admission even when
    // individual fields retain facts from a newer-sampled, earlier-issued read.
    const offeredReadIsNewer =
      offeredMetadata.read.source.revision > currentMetadata.read.source.revision;
    const base = offeredReadIsNewer ? offered : current;
    const baseMetadata = offeredReadIsNewer ? offeredMetadata : currentMetadata;
    const currentValues: Record<string, unknown> = current;
    const offeredValues: Record<string, unknown> = offered;
    let next = base.key === current.key ? base : { ...base, key: current.key };
    let values: Record<string, unknown> = next;
    let copied = next !== base;
    // Older donors often leave every receipt intact; copy only changed field metadata.
    let fields: Map<string, FieldObservation> | undefined;
    const keys = new Set([
      ...Object.keys(current),
      ...Object.keys(offered),
      ...currentMetadata.fields.keys(),
      ...offeredMetadata.fields.keys(),
    ]);
    for (const field of keys) {
      if (identityFields.has(field)) {
        continue;
      }
      const currentField = currentMetadata.fields.get(field) ?? currentMetadata.read;
      const offeredField = offeredMetadata.fields.get(field) ?? offeredMetadata.read;
      const merged = mergeSessionFieldObservations(currentField, offeredField);
      const source = merged.useOffered ? offeredValues : currentValues;
      const provenance = merged.observation;
      if (provenance === baseMetadata.read) {
        if (baseMetadata.fields.has(field)) {
          fields ??= new Map(baseMetadata.fields);
          fields.delete(field);
        }
      } else if (provenance !== baseMetadata.fields.get(field)) {
        fields ??= new Map(baseMetadata.fields);
        fields.set(field, provenance);
      }
      if (
        values[field] === source[field] &&
        Object.hasOwn(values, field) === Object.hasOwn(source, field)
      ) {
        continue;
      }
      if (!copied) {
        next = { ...base };
        values = next;
        copied = true;
      }
      if (Object.hasOwn(source, field)) {
        values[field] = source[field];
      } else {
        delete values[field];
      }
    }
    const nextMetadata = fields ? { ...baseMetadata, fields } : baseMetadata;
    if (next === current || isShallowEqualSessionRow(next, current)) {
      observationsByRow.set(current, nextMetadata);
      return current;
    }
    observationsByRow.set(next, nextMetadata);
    return next;
  };
  const observeFields = (
    row: GatewaySessionRow,
    names: readonly string[],
    observation: FieldObservation,
    agentId?: string | null,
  ): SessionRowFieldSelector => {
    const current = metadata(row, agentId);
    const fields = new Map(current.fields);
    for (const name of names) {
      if (!identityFields.has(name)) {
        fields.set(name, observation);
      }
    }
    observationsByRow.set(row, { ...current, fields });
    return selectSourceFields(row, observation, agentId);
  };
  return {
    reset() {
      observationsByRow = new WeakMap<GatewaySessionRow, RowObservation>();
    },
    owner,
    identity,
    inheritRow,
    mergeRow,
    observeReadRow,
    observeFields,
    fieldNames: (row: GatewaySessionRow): string[] => [
      ...new Set([...Object.keys(row), ...metadata(row).fields.keys()]),
    ],
    fieldObservation: (row: GatewaySessionRow, field: string): FieldObservation => {
      const observed = metadata(row);
      return observed.fields.get(field) ?? observed.read;
    },
    bindOwner(row: GatewaySessionRow, agentId?: string | null) {
      if (!observationsByRow.has(row)) {
        observationsByRow.set(row, metadata(row, agentId));
      }
    },
    rowRevision: (row: GatewaySessionRow) => observationsByRow.get(row)?.read.source.revision ?? 0,
    hasObservation: (row: GatewaySessionRow) => {
      const observed = observationsByRow.get(row);
      if (!observed) {
        return false;
      }
      if (observed.read.source.revision > 0) {
        return true;
      }
      for (const field of observed.fields.values()) {
        if (field.source.event === true) {
          return true;
        }
      }
      return false;
    },
    hasNewerFacts: (row: GatewaySessionRow, revision: number) => {
      const observed = observationsByRow.get(row);
      if (!observed) {
        return revision < 0;
      }
      if (observed.read.source.revision > revision) {
        return true;
      }
      for (const field of observed.fields.values()) {
        if (
          field.source.revision > revision ||
          (field.writer !== undefined && field.writer.revision > revision) ||
          (field.writer?.readCutoff !== undefined && field.writer.readCutoff >= revision)
        ) {
          return true;
        }
      }
      return false;
    },
  };
}
