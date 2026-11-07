import path from "node:path";
import JSON5 from "json5";
import type { PluginSourceSnapshotEntry } from "./plugin-source-snapshot-entries.js";

type FileEntry = Extract<PluginSourceSnapshotEntry, { kind: "file" }>;

/** Seal only resolution inputs, including captured relative configuration ancestors. */
export function collectPluginSnapshotMetadata(
  entries: PluginSourceSnapshotEntry[],
  read: (entry: FileEntry) => string,
  extraConfiguration?: string,
) {
  const files = new Map(
    entries
      .filter((entry): entry is FileEntry => entry.kind === "file")
      .map((entry) => [entry.path, entry]),
  );
  const resolution: Record<string, string> = {};
  const configuration: Record<string, string> = {};
  const pending: FileEntry[] = [];
  for (const entry of files.values()) {
    const name = path.basename(entry.path);
    if (name === "package.json") {
      resolution[path.dirname(entry.path)] = read(entry);
    } else if (name === "tsconfig.json" || name === "jsconfig.json") {
      pending.push(entry);
    }
  }
  if (extraConfiguration) {
    const entry = files.get(extraConfiguration);
    if (entry) {
      pending.push(entry);
    }
  }
  while (pending.length) {
    const entry = pending.pop()!;
    if (Object.hasOwn(configuration, entry.path)) {
      continue;
    }
    const text = read(entry);
    configuration[entry.path] = text;
    let parsed: unknown;
    try {
      parsed = JSON5.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !("extends" in parsed)) {
      continue;
    }
    const bases: unknown[] = Array.isArray(parsed.extends) ? parsed.extends : [parsed.extends];
    for (const base of bases) {
      if (typeof base !== "string" || !base.startsWith(".")) {
        continue;
      }
      const target = path.normalize(path.join(path.dirname(entry.path), base));
      const parent = files.get(target) ?? files.get(`${target}.json`);
      if (parent) {
        pending.push(parent);
      }
    }
  }
  return { resolution, configuration };
}
