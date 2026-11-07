import path from "node:path";
import JSON5 from "json5";
import type { PluginSourceSnapshotEntry } from "./plugin-source-snapshot-entries.js";
import { createPluginSnapshotResolver } from "./plugin-source-snapshot-resolution.js";

type FileEntry = Extract<PluginSourceSnapshotEntry, { kind: "file" }>;

/** Seal only resolution inputs, including captured package and relative configuration ancestors. */
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
    const basename = path.basename(entry.path);
    const name = process.platform === "win32" ? basename.toLowerCase() : basename;
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
  const root = path.resolve(".");
  const resolver = createPluginSnapshotResolver({
    payloadRoot: root,
    rootDir: root,
    sourceAliases: {},
    sourceLinks: new Map(
      entries.flatMap((entry) =>
        entry.kind === "link"
          ? [[path.join(root, entry.path), path.join(root, entry.target)] as const]
          : [],
      ),
    ),
    entries: new Map(entries.map((entry) => [path.join(root, entry.path), entry])),
    resolution: new Map(
      Object.entries(resolution).map(([key, value]) => [path.join(root, key), value]),
    ),
    configuration: new Map(),
  });
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
      if (typeof base !== "string") {
        continue;
      }
      const target = resolver.configurationPath(path.join(root, entry.path), base);
      const parent = target ? files.get(path.relative(root, target)) : undefined;
      if (parent) {
        pending.push(parent);
      }
    }
  }
  return { resolution, configuration };
}
