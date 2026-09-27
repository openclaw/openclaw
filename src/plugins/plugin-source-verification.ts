import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  hashPluginSourceFile,
  isPluginSourceEntry,
  pluginSourceFileIdentity,
  pluginSourceIdentityChangedOnlyByCtime,
  pluginSourceStatIdentity,
} from "./plugin-source-file.js";

export function readPluginSourceDirectory(source: string) {
  const entries = fs
    .readdirSync(source, { withFileTypes: true })
    .filter((entry) => isPluginSourceEntry(entry.name))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const content = entries.map((entry) => [
    entry.name,
    entry.isSymbolicLink() ? fs.readlinkSync(path.join(source, entry.name)) : null,
  ]);
  return {
    names: entries.map((entry) => entry.name),
    contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}

// Directory membership is checked separately, without another owner's excluded
// entries. Their retirement changes directory timestamps, not plugin source.
export const pluginSourceInputIdentity = (stat: fs.BigIntStats): string =>
  stat.isDirectory() ? `${stat.dev}:${stat.ino}:${stat.mode}` : pluginSourceStatIdentity(stat);

export type PluginSourceInput = {
  identity: string;
  contentHash: string;
  sizeBytes: number;
  directory: boolean;
  boundary: string;
  native?: boolean;
};

export function verifyPluginSourceInputs(
  inputs: ReadonlyMap<string, PluginSourceInput>,
  sources: Iterable<string>,
): void {
  for (const source of sources) {
    const input = inputs.get(source)!;
    const identity = input.native
      ? pluginSourceFileIdentity(source, input.boundary)
      : pluginSourceInputIdentity(fs.statSync(source, { bigint: true }));
    if (
      input.native &&
      identity !== input.identity &&
      pluginSourceIdentityChangedOnlyByCtime(input.identity, identity) &&
      hashPluginSourceFile(source, input.boundary).contentHash === input.contentHash
    ) {
      input.identity = identity;
    }
    if (
      fs.realpathSync(source) !== source ||
      identity !== input.identity ||
      (input.directory
        ? readPluginSourceDirectory(source).contentHash
        : input.native
          ? input.contentHash
          : hashPluginSourceFile(source, input.boundary).contentHash) !== input.contentHash
    ) {
      throw new Error(
        "Plugin source changed while preparing its reload; retry after the edit finishes.",
      );
    }
  }
}
