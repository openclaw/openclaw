import type { Command } from "commander";
import type { BrowserFormField } from "../../browser/client-actions-core.js";
import type { SnapshotResult } from "../../browser/client.js";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { callBrowserRequest, type BrowserParentOpts } from "../browser-cli-shared.js";

export type BrowserActionContext = {
  parent: BrowserParentOpts;
  profile: string | undefined;
};

export function resolveBrowserActionContext(
  cmd: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
): BrowserActionContext {
  const parent = parentOpts(cmd);
  const profile = parent?.browserProfile;
  return { parent, profile };
}

export async function callBrowserAct<T = unknown>(params: {
  parent: BrowserParentOpts;
  profile?: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<T> {
  return await callBrowserRequest<T>(
    params.parent,
    {
      method: "POST",
      path: "/act",
      query: params.profile ? { profile: params.profile } : undefined,
      body: params.body,
    },
    { timeoutMs: params.timeoutMs ?? 20000 },
  );
}

export function requireRef(ref: string | undefined) {
  const refValue = typeof ref === "string" ? ref.trim() : "";
  if (!refValue) {
    defaultRuntime.error(danger("ref is required"));
    defaultRuntime.exit(1);
    return null;
  }
  return refValue;
}

async function readFile(path: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return await fs.readFile(path, "utf8");
}

export type BrowserFieldValue = string | number | boolean;

export type BrowserFieldDescriptor = {
  type: string;
  ref?: string;
  label?: string;
  value?: BrowserFieldValue;
};

function parseFieldDescriptor(entry: unknown, index: number): BrowserFieldDescriptor {
  if (!entry || typeof entry !== "object") {
    throw new Error(`fields[${index}] must be an object`);
  }
  const rec = entry as Record<string, unknown>;
  const ref = typeof rec.ref === "string" ? rec.ref.trim() : "";
  const label = typeof rec.label === "string" ? rec.label.trim() : "";
  const type = typeof rec.type === "string" ? rec.type.trim() : "";
  if (!type) {
    throw new Error(`fields[${index}] must include type`);
  }
  if (!ref && !label) {
    throw new Error(`fields[${index}] must include ref or label`);
  }
  if (
    rec.value !== undefined &&
    rec.value !== null &&
    typeof rec.value !== "string" &&
    typeof rec.value !== "number" &&
    typeof rec.value !== "boolean"
  ) {
    throw new Error(`fields[${index}].value must be string, number, boolean, or null`);
  }
  return {
    type,
    ref: ref || undefined,
    label: label || undefined,
    value:
      rec.value === null || rec.value === undefined ? undefined : (rec.value as BrowserFieldValue),
  };
}

export async function readFields(opts: {
  fields?: string;
  fieldsFile?: string;
}): Promise<BrowserFieldDescriptor[]> {
  const payload = opts.fieldsFile ? await readFile(opts.fieldsFile) : (opts.fields ?? "");
  if (!payload.trim()) {
    throw new Error("fields are required");
  }
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("fields must be an array");
  }
  return parsed.map(parseFieldDescriptor);
}

export function resolveFieldsFromSnapshot(
  descriptors: BrowserFieldDescriptor[],
  snapshot: SnapshotResult,
): BrowserFormField[] {
  if (snapshot.format !== "ai") {
    throw new Error("Label-based fill requires an AI snapshot");
  }
  const refs = snapshot.refs ?? {};
  return descriptors.map((field, index) => {
    if (field.ref) {
      return field.value === undefined
        ? { ref: field.ref, type: field.type }
        : { ref: field.ref, type: field.type, value: field.value };
    }
    const label = field.label ?? "";
    const matches = Object.entries(refs)
      .filter(([, meta]) => meta.role === field.type && meta.name === label)
      .map(([ref]) => ref);
    if (matches.length === 0) {
      throw new Error(
        `fields[${index}] no snapshot match for label "${label}" and type "${field.type}"`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `fields[${index}] has multiple matches for label "${label}" and type "${field.type}"`,
      );
    }
    const ref = matches[0];
    return field.value === undefined
      ? { ref, type: field.type }
      : { ref, type: field.type, value: field.value };
  });
}
