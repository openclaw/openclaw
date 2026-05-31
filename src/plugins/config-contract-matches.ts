import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";

export type PluginConfigContractMatch = {
  path: string;
  value: unknown;
};

type TraversalState = {
  segments: string[];
  value: unknown;
};

function normalizePathPattern(pathPattern: string): string[] {
  return normalizeStringEntries(pathPattern.split("."));
}

function appendPathSegment(path: string, segment: string): string {
  if (!path) {
    return segment;
  }
  return /^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`;
}

function parseCanonicalArrayIndex(segment: string, length: number): number | null {
  const index = parseConfigPathArrayIndex(segment);
  return index !== undefined && index < length ? index : null;
}

/** Collects values that match a dot-separated config path pattern with `*` wildcards. */
export function collectPluginConfigContractMatches(params: {
  root: unknown;
  pathPattern: string;
}): PluginConfigContractMatch[] {
  const pattern = normalizePathPattern(params.pathPattern);
  if (pattern.length === 0) {
    return [];
  }

  let states: TraversalState[] = [{ segments: [], value: params.root }];
  for (const segment of pattern) {
    const nextStates: TraversalState[] = [];
    for (const state of states) {
      if (segment === "*") {
        // Wildcards expand across both arrays and objects while preserving the
        // concrete path so doctor/repair messages can point at exact entries.
        if (Array.isArray(state.value)) {
          for (const [index, value] of state.value.entries()) {
            nextStates.push({
              segments: [...state.segments, String(index)],
              value,
            });
          }
          continue;
        }
        if (isRecord(state.value)) {
          for (const [key, value] of Object.entries(state.value)) {
            nextStates.push({
              segments: [...state.segments, key],
              value,
            });
          }
        }
        continue;
      }
      if (Array.isArray(state.value)) {
        const index = parseCanonicalArrayIndex(segment, state.value.length);
        if (index !== null) {
          // Keep the caller's canonical segment text for stable output paths.
          nextStates.push({
            segments: [...state.segments, segment],
            value: state.value[index],
          });
        }
        continue;
      }
      if (!isRecord(state.value) || !Object.hasOwn(state.value, segment)) {
        continue;
      }
      nextStates.push({
        segments: [...state.segments, segment],
        value: state.value[segment],
      });
    }
    states = nextStates;
    if (states.length === 0) {
      break;
    }
  }

  return states.map((state) => ({
    path: state.segments.reduce(appendPathSegment, ""),
    value: state.value,
  }));
}
