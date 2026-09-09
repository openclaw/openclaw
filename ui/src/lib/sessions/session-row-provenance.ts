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

type FieldObservation = Readonly<{
  revision: number;
  updatedAt: number | null;
  event?: true;
}>;

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
      read: { revision: 0, updatedAt: row.updatedAt ?? null },
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
          !identityFields.has(name) && (projected.fields.get(name) ?? projected.read) === source,
      );
    };
  };
  const observeReadRow = (
    row: GatewaySessionRow,
    revision: number,
    agentId?: string | null,
  ): SessionRowFieldSelector => {
    if ((observationsByRow.get(row)?.read.revision ?? 0) >= revision) {
      // A merge may have attached another read's token to this same row object.
      return () => [];
    }
    const fields = new Map<string, FieldObservation>();
    // Only these optional fields are deliberately omitted by non-enriched reads.
    for (const field of ["derivedTitle", "lastMessagePreview"] as const) {
      if (row[field] === undefined) {
        fields.set(field, { revision: 0, updatedAt: null });
      }
    }
    const readAgentId =
      parseAgentSessionKey(row.key)?.agentId ?? row.agentId?.trim() ?? agentId?.trim();
    const read: FieldObservation = { revision, updatedAt: row.updatedAt ?? null };
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
  const fieldIsNewer = (candidate: FieldObservation, current: FieldObservation) => {
    if (
      (candidate.event || current.event) &&
      candidate.updatedAt !== null &&
      current.updatedAt !== null &&
      candidate.updatedAt !== current.updatedAt
    ) {
      return candidate.updatedAt > current.updatedAt;
    }
    return candidate.revision > current.revision;
  };
  const mergeRow = (
    current: GatewaySessionRow,
    offered: GatewaySessionRow,
    agentId?: string | null,
  ): GatewaySessionRow => {
    const key = identity(current, agentId);
    if (!key || key !== identity(offered, agentId)) {
      return current;
    }
    const currentMetadata = metadata(current, agentId);
    const offeredMetadata = metadata(offered, agentId);
    const offeredReadIsNewer = offeredMetadata.read.revision > currentMetadata.read.revision;
    const base = offeredReadIsNewer ? offered : current;
    const baseMetadata = offeredReadIsNewer ? offeredMetadata : currentMetadata;
    const currentValues: Record<string, unknown> = current;
    const offeredValues: Record<string, unknown> = offered;
    let next = base.key === current.key ? base : { ...base, key: current.key };
    let values: Record<string, unknown> = next;
    let copied = next !== base;
    const fields = new Map<string, FieldObservation>();
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
      const useOffered = fieldIsNewer(offeredField, currentField);
      const source = useOffered ? offeredValues : currentValues;
      const provenance = useOffered ? offeredField : currentField;
      if (provenance !== baseMetadata.read) {
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
    const nextMetadata = { ...baseMetadata, fields };
    if (isShallowEqualSessionRow(next, current)) {
      observationsByRow.set(current, nextMetadata);
      return current;
    }
    observationsByRow.set(next, nextMetadata);
    return next;
  };
  const observeEvent = (
    row: GatewaySessionRow,
    names: readonly string[],
    revision: number,
    updatedAt: number | null,
    agentId?: string | null,
  ): SessionRowFieldSelector => {
    const current = metadata(row, agentId);
    const fields = new Map(current.fields);
    const event: FieldObservation = { revision, event: true, updatedAt };
    for (const name of names) {
      if (!identityFields.has(name)) {
        fields.set(name, event);
      }
    }
    observationsByRow.set(row, { ...current, fields });
    return selectSourceFields(row, event, agentId);
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
    observeEvent,
    bindOwner(row: GatewaySessionRow, agentId?: string | null) {
      if (!observationsByRow.has(row)) {
        observationsByRow.set(row, metadata(row, agentId));
      }
    },
    rowRevision: (row: GatewaySessionRow) => metadata(row).read.revision,
    hasObservation: (row: GatewaySessionRow) => {
      const observed = metadata(row);
      return (
        observed.read.revision > 0 ||
        [...observed.fields.values()].some((field) => field.event === true)
      );
    },
    hasNewerFacts: (row: GatewaySessionRow, revision: number) => {
      const observed = metadata(row);
      return [observed.read, ...observed.fields.values()].some(
        (field) => field.revision > revision,
      );
    },
  };
}
