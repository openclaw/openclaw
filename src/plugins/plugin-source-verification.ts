import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  hashPluginSourceFile,
  pluginSourceFileIdentity,
  pluginSourceIdentityChangedOnlyByCtime,
  pluginSourceStatIdentity,
} from "./plugin-source-file.js";

export const pluginSourceContentHash = (content: string[]) =>
  createHash("sha256").update(JSON.stringify(content)).digest("hex");

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
      : pluginSourceStatIdentity(fs.statSync(source, { bigint: true }));
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
        ? pluginSourceContentHash(fs.readdirSync(source).toSorted())
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
