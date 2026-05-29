import type { ConfigUiHint } from "../shared/config-ui-hints-types.js";
import { computeBaseConfigSchemaResponse, type BaseConfigSchemaResponse } from "./schema-base.js";

type JsonSchemaNode = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
};

export type ExperimentalConfigFlag = {
  path: string;
  label: string;
  summary: string;
};

export type ExperimentalConfigFlagState = ExperimentalConfigFlag & {
  segments: string[];
  authored: boolean;
  on: boolean;
};

export type ExperimentalConfigFlagDelta = ExperimentalConfigFlagState & {
  next: boolean;
};

function hasExperimentalSegment(path: string): boolean {
  const segments = path.split(".");
  return segments.slice(0, -1).includes("experimental");
}

function isBooleanSchemaNode(node: JsonSchemaNode): boolean {
  if (node.type === "boolean") {
    return true;
  }
  if (Array.isArray(node.type) && node.type.includes("boolean")) {
    return true;
  }
  return [...(node.anyOf ?? []), ...(node.oneOf ?? [])].some(isBooleanSchemaNode);
}

function collectBooleanSchemaLeaves(
  node: JsonSchemaNode,
  path: string,
  output: Map<string, JsonSchemaNode>,
): void {
  const properties = node.properties;
  if (properties) {
    for (const [key, child] of Object.entries(properties)) {
      collectBooleanSchemaLeaves(child, path ? `${path}.${key}` : key, output);
    }
  }
  for (const child of node.allOf ?? []) {
    collectBooleanSchemaLeaves(child, path, output);
  }
  if (path && !properties && isBooleanSchemaNode(node)) {
    output.set(path, node);
  }
}

function labelFor(path: string, node: JsonSchemaNode, hint?: ConfigUiHint): string {
  return hint?.label ?? node.title ?? path;
}

function summaryFor(path: string, node: JsonSchemaNode, hint?: ConfigUiHint): string {
  return hint?.help ?? node.description ?? path;
}

function readBoolState(
  root: unknown,
  segments: readonly string[],
): { authored: boolean; on: boolean } {
  let cur: unknown = root;
  for (const segment of segments) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) {
      return { authored: false, on: false };
    }
    const record = cur as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) {
      return { authored: false, on: false };
    }
    cur = record[segment];
  }
  return { authored: true, on: cur === true };
}

function setAt(root: Record<string, unknown>, segments: readonly string[], value: boolean): void {
  let cur = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const next = cur[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cur[segment] = {};
    }
    cur = cur[segment] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]] = value;
}

export function listExperimentalConfigFlags(
  schemaResponse: BaseConfigSchemaResponse = computeBaseConfigSchemaResponse(),
): ExperimentalConfigFlag[] {
  const booleanLeaves = new Map<string, JsonSchemaNode>();
  collectBooleanSchemaLeaves(schemaResponse.schema as JsonSchemaNode, "", booleanLeaves);
  return [...booleanLeaves.entries()]
    .filter(([path]) => hasExperimentalSegment(path))
    .map(([path, node]) => {
      const hint = schemaResponse.uiHints[path];
      return {
        path,
        label: labelFor(path, node, hint),
        summary: summaryFor(path, node, hint),
      };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

export function readExperimentalConfigFlagStates(root: unknown): ExperimentalConfigFlagState[] {
  return listExperimentalConfigFlags().map((flag) => {
    const segments = flag.path.split(".");
    const state = readBoolState(root, segments);
    return {
      path: flag.path,
      label: flag.label,
      summary: flag.summary,
      segments,
      authored: state.authored,
      on: state.on,
    };
  });
}

export function formatExperimentalConfigFlagStates(
  states: readonly (ExperimentalConfigFlag & { on: boolean })[],
): string {
  const lines = states.map(
    (state) => `- ${state.on ? "on" : "off"} ${state.path} - ${state.label}`,
  );
  return ["Experimental flags:", ...lines].join("\n");
}

export function resolveExperimentalConfigFlag(
  selector: string,
): ExperimentalConfigFlag | undefined {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const flags = listExperimentalConfigFlags();
  const exact = flags.find((flag) => flag.path.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }
  const leafMatches = flags.filter(
    (flag) => flag.path.split(".").at(-1)?.toLowerCase() === normalized,
  );
  return leafMatches.length === 1 ? leafMatches[0] : undefined;
}

export function applyExperimentalConfigSelection(
  root: Record<string, unknown>,
  selectedPaths: ReadonlySet<string>,
): {
  nextConfig: Record<string, unknown>;
  deltas: ExperimentalConfigFlagDelta[];
} {
  const states = readExperimentalConfigFlagStates(root);
  const deltas = states.flatMap((state) =>
    selectedPaths.has(state.path) === state.on && (state.on || state.authored)
      ? []
      : [{ ...state, next: selectedPaths.has(state.path) }],
  );
  const nextConfig = structuredClone(root);
  for (const delta of deltas) {
    setAt(nextConfig, delta.segments, delta.next);
  }
  return { nextConfig, deltas };
}

export function applyExperimentalConfigFlagValue(
  root: Record<string, unknown>,
  params: { path: string; value: boolean },
): {
  nextConfig: Record<string, unknown>;
  delta: ExperimentalConfigFlagDelta | null;
} {
  const state = readExperimentalConfigFlagStates(root).find((flag) => flag.path === params.path);
  if (!state || (state.on === params.value && (params.value || state.authored))) {
    return { nextConfig: structuredClone(root), delta: null };
  }
  const nextConfig = structuredClone(root);
  const delta = { ...state, next: params.value };
  setAt(nextConfig, state.segments, params.value);
  return { nextConfig, delta };
}
