import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rewritePnpmVersionedOpenClawEntryPath } from "./openclaw-root.js";

const INSTALLATION_ID_LENGTH = 16;
const PROCESS_TITLE_PATTERN = /^(openclaw(?:-[a-z0-9-]+)?)@([a-f0-9]{16}(?:\+[a-f0-9]{16})*)$/u;

function createOpenClawInstallationId(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, INSTALLATION_ID_LENGTH);
}

export function resolveOpenClawInstallationId(root: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedEntry = path.join(resolvedRoot, "openclaw.mjs");
  const stableEntry = rewritePnpmVersionedOpenClawEntryPath(resolvedEntry);
  if (stableEntry !== resolvedEntry) {
    return createOpenClawInstallationId(path.dirname(stableEntry));
  }
  try {
    const canonicalRoot = fs.realpathSync.native(resolvedRoot);
    const canonicalEntry = path.join(canonicalRoot, "openclaw.mjs");
    const stableCanonicalEntry = rewritePnpmVersionedOpenClawEntryPath(canonicalEntry);
    return createOpenClawInstallationId(
      stableCanonicalEntry === canonicalEntry ? canonicalRoot : path.dirname(stableCanonicalEntry),
    );
  } catch {
    return createOpenClawInstallationId(resolvedRoot);
  }
}

export function formatOpenClawProcessTitle(name: string, installRoot: string): string {
  return `${name}@${resolveOpenClawInstallationId(installRoot)}`;
}

export function formatOpenClawProcessTitleForRoots(
  name: string,
  installRoots: readonly string[],
): string {
  const installationIds = [...new Set(installRoots.map(resolveOpenClawInstallationId))];
  return `${name}@${installationIds.join("+")}`;
}

export function parseOpenClawProcessTitle(
  title: string,
): { name: string; installationId: string; installationIds: string[] } | undefined {
  const match = PROCESS_TITLE_PATTERN.exec(title);
  if (!match) {
    return undefined;
  }
  const installationIds = match[2]!.split("+");
  return { name: match[1]!, installationId: installationIds[0]!, installationIds };
}
