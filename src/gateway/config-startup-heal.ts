import { isBlockedObjectKey } from "../config/prototype-keys.js";
import type {
  ConfigFileSnapshot,
  ConfigValidationIssue,
  OpenClawConfig,
} from "../config/types.openclaw.js";

const PRUNED_OBJECT = Symbol("pruned-object");

type UnsetResult = {
  changed: boolean;
  value: unknown;
};

function isNumericPathSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnObjectKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parsePathSegments(raw: string): string[] | null {
  const segments = raw
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }
  for (const segment of segments) {
    if (isNumericPathSegment(segment)) {
      continue;
    }
    if (isBlockedObjectKey(segment)) {
      return null;
    }
  }
  return segments;
}

function shouldStripIssue(issue: ConfigValidationIssue): boolean {
  if (!Array.isArray(issue.allowedValues) || issue.allowedValues.length === 0) {
    return false;
  }
  return Boolean(issue.path?.trim());
}

function unsetPathAt(value: unknown, segments: string[], depth: number): UnsetResult {
  if (depth >= segments.length) {
    return { changed: false, value };
  }
  const segment = segments[depth];
  const isLeaf = depth === segments.length - 1;

  if (Array.isArray(value)) {
    if (!isNumericPathSegment(segment)) {
      return { changed: false, value };
    }
    const index = Number.parseInt(segment, 10);
    if (!Number.isFinite(index) || index < 0 || index >= value.length) {
      return { changed: false, value };
    }
    if (isLeaf) {
      const next = value.slice();
      next.splice(index, 1);
      return { changed: true, value: next };
    }
    const child = unsetPathAt(value[index], segments, depth + 1);
    if (!child.changed) {
      return { changed: false, value };
    }
    const next = value.slice();
    if (child.value === PRUNED_OBJECT) {
      next.splice(index, 1);
    } else {
      next[index] = child.value;
    }
    return { changed: true, value: next };
  }

  if (!isPlainObject(value) || !hasOwnObjectKey(value, segment)) {
    return { changed: false, value };
  }
  if (isLeaf) {
    const next: Record<string, unknown> = { ...value };
    delete next[segment];
    return {
      changed: true,
      value: Object.keys(next).length === 0 ? PRUNED_OBJECT : next,
    };
  }

  const child = unsetPathAt(value[segment], segments, depth + 1);
  if (!child.changed) {
    return { changed: false, value };
  }
  const next: Record<string, unknown> = { ...value };
  if (child.value === PRUNED_OBJECT) {
    delete next[segment];
  } else {
    next[segment] = child.value;
  }
  return {
    changed: true,
    value: Object.keys(next).length === 0 ? PRUNED_OBJECT : next,
  };
}

function unsetPath(
  config: OpenClawConfig,
  segments: string[],
): { changed: boolean; next: OpenClawConfig } {
  if (segments.length === 0) {
    return { changed: false, next: config };
  }
  const result = unsetPathAt(config, segments, 0);
  if (!result.changed) {
    return { changed: false, next: config };
  }
  if (result.value === PRUNED_OBJECT) {
    return { changed: true, next: {} };
  }
  if (isPlainObject(result.value)) {
    return { changed: true, next: result.value as OpenClawConfig };
  }
  return { changed: false, next: config };
}

function comparePathSegments(a: string[], b: string[]): number {
  const parentA = a.slice(0, -1).join(".");
  const parentB = b.slice(0, -1).join(".");
  if (parentA === parentB) {
    const leafA = a[a.length - 1] ?? "";
    const leafB = b[b.length - 1] ?? "";
    if (isNumericPathSegment(leafA) && isNumericPathSegment(leafB)) {
      return Number.parseInt(leafB, 10) - Number.parseInt(leafA, 10);
    }
  }
  if (a.length !== b.length) {
    return b.length - a.length;
  }
  return a.join(".").localeCompare(b.join("."));
}

export function stripAllowedValueIssuesFromConfig(params: {
  config: OpenClawConfig;
  issues: ConfigValidationIssue[];
}): { config: OpenClawConfig; strippedPaths: string[] } {
  const unique = new Map<string, string[]>();
  for (const issue of params.issues) {
    if (!shouldStripIssue(issue)) {
      continue;
    }
    const segments = parsePathSegments(issue.path);
    if (!segments) {
      continue;
    }
    unique.set(segments.join("."), segments);
  }

  const candidates = Array.from(unique.values()).toSorted(comparePathSegments);
  let next = params.config;
  const strippedPaths: string[] = [];
  for (const segments of candidates) {
    const result = unsetPath(next, segments);
    if (!result.changed) {
      continue;
    }
    next = result.next;
    strippedPaths.push(segments.join("."));
  }
  return { config: next, strippedPaths };
}

export async function tryStartupConfigAllowedValueSelfHeal(params: {
  snapshot: ConfigFileSnapshot;
  writeConfig: (cfg: OpenClawConfig) => Promise<void>;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  logWarn: (message: string) => void;
}): Promise<ConfigFileSnapshot> {
  const { snapshot } = params;
  if (!snapshot.exists || snapshot.valid) {
    return snapshot;
  }
  const resolved = snapshot.resolved;
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    return snapshot;
  }

  const stripped = stripAllowedValueIssuesFromConfig({
    config: structuredClone(resolved),
    issues: snapshot.issues,
  });
  if (stripped.strippedPaths.length === 0) {
    return snapshot;
  }

  try {
    await params.writeConfig(stripped.config);
  } catch (err) {
    params.logWarn(
      `gateway: startup enum self-heal failed while stripping invalid config paths (${stripped.strippedPaths.join(", ")}): ${String(err)}`,
    );
    return snapshot;
  }

  params.logWarn(
    `gateway: stripped invalid config enum paths during startup: ${stripped.strippedPaths.join(", ")}`,
  );
  return await params.readSnapshot();
}
