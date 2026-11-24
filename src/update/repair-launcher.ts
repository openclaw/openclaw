import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveIsConfigReadOnly } from "../config/paths.js";
import { hasErrnoCode } from "../infra/errno.js";
import { writeGitReleaseLauncher } from "../infra/git-release-launcher.js";
import { readPackageReleaseSlotSync } from "../infra/package-release-slot-path.js";
import { resolvePrefix } from "./store.js";

// #204192: the installed d44f263 launcher counted `gateway status` as a start.
// Exact frozen bytes, not a header, distinguish it from an operator's custom launcher.
// Retire this repair with the legacy Git-release bridge; no new launcher format or trial owner.
const LEGACY_LAUNCHER_SHA256 = "2a385c15d15dd9df5cd3a968909600c548ee70100334a7c2d5ba4fcfe6328fda";

/** Refresh only a known legacy executable belonging to this selected release. */
export async function repairLegacyGitReleaseLauncher(params: {
  root: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const env = params.env ?? process.env;
  if (resolveIsConfigReadOnly(env)) {
    return null;
  }
  const slot = readPackageReleaseSlotSync(path.join(resolvePrefix(env), "openclaw"));
  if (!slot || slot.releaseRoot !== (await fs.realpath(params.root))) {
    return null;
  }
  const launcher = path.join(slot.prefix, "openclaw-launcher.mjs");
  const stat = await fs.lstat(launcher).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return null;
  });
  const uid = process.getuid?.();
  if (
    !stat?.isFile() ||
    (uid !== undefined && (stat.uid !== uid || (await fs.stat(slot.prefix)).uid !== uid))
  ) {
    return null;
  }
  const source = await fs.readFile(launcher);
  if (createHash("sha256").update(source).digest("hex") !== LEGACY_LAUNCHER_SHA256) {
    return null;
  }
  // Keep the old trial/rollback protocol. The next release update installs the resident
  // launcher; installing it now would abandon the legacy record's phase-less trial.
  return await writeGitReleaseLauncher(slot.prefix);
}
