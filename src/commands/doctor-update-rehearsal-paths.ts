import { lstatSync, type Stats } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assertUpdateCandidatePluginCodeLink,
  type UpdateCandidatePluginCodeLink,
} from "../infra/update-candidate-plugin-code-links.js";

export function refuseRehearsal(detail: string): never {
  throw new Error(
    `Legacy update rehearsal was refused: ${detail}. Run npx openclaw@latest update from a terminal for a protected update.`,
  );
}

export function isWithinRehearsal(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** Strict data inspection; only the terminal entry in a code walk may be an owned link. */
export function createRehearsalPathInspector(
  stateDir: string,
  facts: readonly UpdateCandidatePluginCodeLink[],
) {
  const codeLinks = new Map<string, UpdateCandidatePluginCodeLink>();
  for (const fact of facts) {
    const previous = codeLinks.get(fact.path);
    if (previous && !isDeepStrictEqual(previous, fact)) {
      refuseRehearsal(`conflicting plugin code link identities: ${fact.path}`);
    }
    codeLinks.set(fact.path, fact);
  }
  const uid = process.getuid?.();
  const identities = new Map<string, Stats>();
  function inspectPath(
    filename: string,
    privateMode = false,
    allowCodeLink = false,
  ): Stats | undefined {
    if (path.normalize(filename) !== filename) {
      refuseRehearsal(`migration data is not a canonical path: ${filename}`);
    }
    if (!path.isAbsolute(filename) || !isWithinRehearsal(stateDir, filename)) {
      refuseRehearsal(`migration data escapes the copied state: ${filename}`);
    }
    let current = stateDir;
    let last: Stats | undefined;
    for (const part of ["", ...path.relative(stateDir, filename).split(path.sep).filter(Boolean)]) {
      current = path.join(current, part);
      try {
        last = lstatSync(current);
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
      const codeLink = allowCodeLink && current === filename ? codeLinks.get(current) : undefined;
      if (codeLink) {
        assertUpdateCandidatePluginCodeLink(codeLink);
      }
      if (
        (last.isSymbolicLink() && !codeLink) ||
        (!last.isDirectory() && !last.isFile() && !codeLink) ||
        (last.isFile() && last.nlink !== 1) ||
        (uid !== undefined && last.uid !== uid) ||
        (process.platform !== "win32" &&
          (current === stateDir || (privateMode && current === filename)) &&
          (last.mode & 0o077) !== 0)
      ) {
        refuseRehearsal(`copied data has unsafe ownership or links: ${current}`);
      }
      const previous = identities.get(current);
      if (previous && (previous.dev !== last.dev || previous.ino !== last.ino)) {
        refuseRehearsal(`copied data identity changed: ${current}`);
      }
      identities.set(current, last);
    }
    return last;
  }
  return { identities, inspectPath };
}
