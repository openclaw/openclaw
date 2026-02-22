/**
 * Config-Aware Editor Tool
 *
 * A structured configuration editor that understands JSON, YAML, and TOML.
 * Instead of string manipulation, it parses → mutates → serializes,
 * guaranteeing syntactically correct output every time.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

type ConfigFormat = "json" | "yaml" | "toml";

function detectFormat(filePath: string): ConfigFormat {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".toml") return "toml";
  return "json"; // .json, .json5, .jsonc, or unknown → treat as JSON
}

// ---------------------------------------------------------------------------
// Parsers & serializers (lazy-loaded to avoid hard deps)
// ---------------------------------------------------------------------------

async function parseContent(raw: string, format: ConfigFormat): Promise<unknown> {
  switch (format) {
    case "json":
      return JSON.parse(raw);
    case "yaml": {
      const yaml = await import("yaml");
      return yaml.parse(raw);
    }
    case "toml": {
      // @ts-expect-error — smol is an optional peer dep
      const toml = await import("smol-toml");
      return toml.parse(raw);
    }
  }
}

async function serializeContent(value: unknown, format: ConfigFormat): Promise<string> {
  switch (format) {
    case "json":
      return JSON.stringify(value, null, 2) + "\n";
    case "yaml": {
      const yaml = await import("yaml");
      return yaml.stringify(value);
    }
    case "toml": {
      // @ts-expect-error — smol is an optional peer dep
      const toml = await import("smol-toml");
      return toml.stringify(value as Record<string, unknown>);
    }
  }
}

// ---------------------------------------------------------------------------
// Dot-path navigation
// ---------------------------------------------------------------------------

function parsePath(dotPath: string): string[] {
  if (!dotPath || dotPath === ".") return [];
  return dotPath.split(".").map((seg) => {
    // Support array index: "items.0.name"
    return seg;
  });
}

function getByPath(obj: unknown, segments: string[]): unknown {
  let current = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      current = current[idx];
    } else {
      current = (current as Record<string, unknown>)[seg];
    }
  }
  return current;
}

function setByPath(obj: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) return value;

  const root = (obj != null && typeof obj === "object") ? structuredClone(obj) : {};
  let current: Record<string, unknown> = root as Record<string, unknown>;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = current[seg];
    if (next == null || typeof next !== "object") {
      // Auto-create intermediate: if next segment is numeric → array, else object
      const nextSeg = segments[i + 1];
      current[seg] = /^\d+$/.test(nextSeg) ? [] : {};
    }
    current = current[seg] as Record<string, unknown>;
  }

  const lastSeg = segments[segments.length - 1];
  if (Array.isArray(current)) {
    const idx = Number(lastSeg);
    (current as unknown[])[idx] = value;
  } else {
    current[lastSeg] = value;
  }

  return root;
}

function deleteByPath(obj: unknown, segments: string[]): unknown {
  if (segments.length === 0) return {};

  const root = structuredClone(obj) as Record<string, unknown>;
  let current: Record<string, unknown> = root;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = current[seg];
    if (next == null || typeof next !== "object") return root; // path doesn't exist
    current = next as Record<string, unknown>;
  }

  const lastSeg = segments[segments.length - 1];
  if (Array.isArray(current)) {
    const idx = Number(lastSeg);
    (current as unknown[]).splice(idx, 1);
  } else {
    delete current[lastSeg];
  }

  return root;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (
    patch == null ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    base == null ||
    typeof base !== "object" ||
    Array.isArray(base)
  ) {
    return patch;
  }
  const result = { ...(base as Record<string, unknown>) };
  for (const [key, val] of Object.entries(patch as Record<string, unknown>)) {
    if (val === null) {
      delete result[key];
    } else {
      result[key] = deepMerge(result[key], val);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const ACTIONS = ["get", "set", "delete", "merge"] as const;

const ConfigEditSchema = Type.Object({
  action: stringEnum(ACTIONS),
  file: Type.String({ description: "Path to the config file (JSON/YAML/TOML)" }),
  path: Type.Optional(
    Type.String({
      description:
        'Dot-separated path to the target field, e.g. "agents.defaults.model.primary". Use "." or omit for root.',
    }),
  ),
  value: Type.Optional(
    Type.String({
      description:
        "JSON-encoded value for set/merge actions. For set: the new value. For merge: object to deep-merge.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export function createConfigEditTool(): AnyAgentTool {
  return {
    label: "Config Editor",
    name: "config_edit",
    description:
      'Structured config editor for JSON/YAML/TOML files. Parse → mutate → serialize (never string-replace). Actions: "get" reads a path, "set" writes a value, "delete" removes a key, "merge" deep-merges an object. Use dot-paths like "a.b.c" to target nested fields. Array indices work too: "items.0.name".',
    parameters: ConfigEditSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const filePath = readStringParam(params, "file", { required: true });
      const dotPath = readStringParam(params, "path") || ".";
      const segments = parsePath(dotPath);

      // Read & parse
      const format = detectFormat(filePath);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch (err: unknown) {
        if (action === "set" || action === "merge") {
          // File doesn't exist yet — start from empty object
          raw = format === "json" ? "{}" : "";
        } else {
          throw new Error(`Cannot read file: ${filePath} — ${(err as Error).message}`);
        }
      }

      let data: unknown;
      try {
        data = raw.trim() ? await parseContent(raw, format) : {};
      } catch (err: unknown) {
        throw new Error(`Parse error (${format}): ${(err as Error).message}`);
      }

      // Execute action
      if (action === "get") {
        const result = getByPath(data, segments);
        return jsonResult({
          ok: true,
          file: filePath,
          format,
          path: dotPath,
          value: result,
        });
      }

      if (action === "set") {
        const valueStr = readStringParam(params, "value", { required: true });
        let parsed: unknown;
        try {
          parsed = JSON.parse(valueStr);
        } catch {
          // Treat as raw string if not valid JSON
          parsed = valueStr;
        }
        data = setByPath(data, segments, parsed);
      } else if (action === "delete") {
        data = deleteByPath(data, segments);
      } else if (action === "merge") {
        const valueStr = readStringParam(params, "value", { required: true });
        let parsed: unknown;
        try {
          parsed = JSON.parse(valueStr);
        } catch {
          throw new Error("merge value must be valid JSON");
        }
        const existing = getByPath(data, segments);
        const merged = deepMerge(existing, parsed);
        data = segments.length > 0 ? setByPath(data, segments, merged) : merged;
      } else {
        throw new Error(`Unknown action: ${action}`);
      }

      // Serialize & write
      const output = await serializeContent(data, format);
      await fs.writeFile(filePath, output, "utf8");

      return jsonResult({
        ok: true,
        file: filePath,
        format,
        action,
        path: dotPath,
        preview: getByPath(data, segments),
      });
    },
  };
}
