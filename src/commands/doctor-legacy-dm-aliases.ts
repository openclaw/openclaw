import { isRecord } from "../utils.js";

function allowFromEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  const na = a.map((v) => String(v).trim()).filter(Boolean);
  const nb = b.map((v) => String(v).trim()).filter(Boolean);
  if (na.length !== nb.length) {
    return false;
  }
  return na.every((v, i) => v === nb[i]);
}

export function normalizeDmAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
}): {
  entry: Record<string, unknown>;
  changed: boolean;
  changes: string[];
} {
  const changes: string[] = [];
  let changed = false;
  let updated: Record<string, unknown> = params.entry;
  const rawDm = updated.dm;
  const dm = isRecord(rawDm) ? structuredClone(rawDm) : null;
  let dmChanged = false;

  const topDmPolicy = updated.dmPolicy;
  const legacyDmPolicy = dm?.policy;
  if (topDmPolicy === undefined && legacyDmPolicy !== undefined) {
    updated = { ...updated, dmPolicy: legacyDmPolicy };
    changed = true;
    if (dm) {
      delete dm.policy;
      dmChanged = true;
    }
    changes.push(`Moved ${params.pathPrefix}.dm.policy → ${params.pathPrefix}.dmPolicy.`);
  } else if (topDmPolicy !== undefined && legacyDmPolicy !== undefined) {
    if (topDmPolicy === legacyDmPolicy) {
      if (dm) {
        delete dm.policy;
        dmChanged = true;
        changes.push(`Removed ${params.pathPrefix}.dm.policy (dmPolicy already set).`);
      }
    }
  }

  const topAllowFrom = updated.allowFrom;
  const legacyAllowFrom = dm?.allowFrom;
  if (topAllowFrom === undefined && legacyAllowFrom !== undefined) {
    updated = { ...updated, allowFrom: legacyAllowFrom };
    changed = true;
    if (dm) {
      delete dm.allowFrom;
      dmChanged = true;
    }
    changes.push(`Moved ${params.pathPrefix}.dm.allowFrom → ${params.pathPrefix}.allowFrom.`);
  } else if (topAllowFrom !== undefined && legacyAllowFrom !== undefined) {
    if (allowFromEqual(topAllowFrom, legacyAllowFrom)) {
      if (dm) {
        delete dm.allowFrom;
        dmChanged = true;
        changes.push(`Removed ${params.pathPrefix}.dm.allowFrom (allowFrom already set).`);
      }
    }
  }

  if (dm && isRecord(rawDm) && dmChanged) {
    const keys = Object.keys(dm);
    if (keys.length === 0) {
      if (updated.dm !== undefined) {
        const { dm: _ignored, ...rest } = updated;
        updated = rest;
        changed = true;
        changes.push(`Removed empty ${params.pathPrefix}.dm after migration.`);
      }
    } else {
      updated = { ...updated, dm };
      changed = true;
    }
  }

  return { entry: updated, changed, changes };
}
