import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.types.js";
import { linkPluginGenerationDependency } from "./plugin-generation-file-capture.js";
import { copyPluginSourceFile } from "./plugin-source-file.js";

type Invalid = (detail: string) => never;

/** Junctions name the final namespace before the complete artifact is renamed into it. */
export function capturePluginSnapshotPayload(
  capture: PluginGenerationArtifact,
  payload: string,
  publishedPayload: string,
  invalid: Invalid,
) {
  const links: Array<[string, string]> = [];
  const copy = (source: string, target: string) => {
    const stat = fs.lstatSync(source, { bigint: true });
    if (stat.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(source), fs.readlinkSync(source));
      if (!isPathInside(capture.boundaryRoot, resolved)) {
        invalid(`capture contains an external link: ${source}`);
      }
      links.push([target, path.join(payload, path.relative(capture.boundaryRoot, resolved))]);
    } else if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(source).toSorted()) {
        copy(path.join(source, name), path.join(target, name));
      }
    } else if (stat.isFile()) {
      copyPluginSourceFile(source, capture.boundaryRoot, target);
    } else {
      invalid(`capture contains a nonregular source: ${source}`);
    }
  };
  copy(capture.boundaryRoot, payload);
  for (const [link, target] of links) {
    linkPluginGenerationDependency(
      link,
      path.join(publishedPayload, path.relative(payload, target)),
      target,
    );
  }
}

export function resolvePluginSnapshotLink(
  payload: string,
  file: string,
  publishedPayload: string,
  invalid: Invalid,
): string {
  const observed = path.resolve(path.dirname(file), fs.readlinkSync(file));
  const target =
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(observed) : observed;
  const physical = path.resolve(payload, path.relative(publishedPayload, target));
  // Captured dependency aliases point to materialized package directories, never other links.
  if (
    !isPathInside(publishedPayload, target) ||
    !isPathInside(payload, physical) ||
    !fs.lstatSync(physical).isDirectory() ||
    !isPathInside(payload, fs.realpathSync(physical))
  ) {
    invalid(`dependency link leaves its frozen closure: ${file}`);
  }
  return physical;
}

/** Logical closure facts exclude ephemeral capture paths and inode identities. */
export function digestPluginSnapshotClosure(
  capture: PluginGenerationArtifact,
  invalid: Invalid,
): string {
  const facts = capture.sourceSnapshotFacts;
  if (!facts) {
    invalid("capture does not own complete source facts");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        aliases: Object.entries(capture.sourceAliases)
          .map(([source, captured]) => [source, path.relative(capture.boundaryRoot, captured)])
          .toSorted(([left], [right]) => left!.localeCompare(right!)),
        directories: [...facts.directories].toSorted(),
        links: [...facts.links].toSorted(([left], [right]) => left.localeCompare(right)),
        files: [...facts.files]
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([file, fact]) => [file, fact.contentHash, fact.sizeBytes, fact.mode]),
        hardlinks: [...facts.hardlinks].toSorted(),
      }),
    )
    .digest("hex");
}
