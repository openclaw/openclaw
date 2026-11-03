import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readGitHead } from "./git-root.js";
import { rewritePnpmVersionedOpenClawEntryPath } from "./openclaw-root.js";

const INSTALLATION_ID_LENGTH = 16;
const PROCESS_TITLE_PATTERN = /^(openclaw(?:-[a-z0-9-]+)?)@([a-f0-9]{16}(?:\+[a-f0-9]{16})*)$/u;
const PROCESS_ANNOUNCEMENT_TITLE_PATTERN =
  /^(?<title>openclaw-(?:tui|update)@[a-f0-9]{16}(?:\+[a-f0-9]{16})*)#(?<pid>\d+)$/u;
const RUNTIME_REVISION_FILES = [
  "dist/.runtime-postbuildstamp",
  "dist/.buildstamp",
  "dist/build-info.json",
  // Every runnable installation loads this owner entry. It keeps revision
  // identity available for older or development builds without metadata.
  "dist/entry.js",
] as const;

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

/** Captures enough stable state to distinguish an aborted update from replacement. */
export function resolveOpenClawInstallationRevision(root: string): string | undefined {
  try {
    const stableEntry = rewritePnpmVersionedOpenClawEntryPath(path.join(root, "openclaw.mjs"));
    const canonicalEntry = fs.realpathSync.native(stableEntry);
    const packageJson: unknown = JSON.parse(
      fs.readFileSync(path.join(path.dirname(canonicalEntry), "package.json"), "utf8"),
    );
    const version =
      typeof packageJson === "object" &&
      packageJson !== null &&
      "version" in packageJson &&
      typeof packageJson.version === "string"
        ? packageJson.version
        : "";
    const gitHead = readGitHead(root)?.value ?? "";
    const runtimeRevision = createHash("sha256");
    for (const relativePath of RUNTIME_REVISION_FILES) {
      try {
        runtimeRevision.update(relativePath).update("\0");
        runtimeRevision.update(
          fs.readFileSync(path.join(path.dirname(canonicalEntry), relativePath)),
        );
      } catch {
        // Packaged and source installations expose different build metadata.
      }
    }
    return `${canonicalEntry}\0${version}\0${gitHead}\0${runtimeRevision.digest("hex")}`;
  } catch {
    return undefined;
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

export function parseOpenClawProcessAnnouncementTitle(
  value: string,
):
  | { processTitle: NonNullable<ReturnType<typeof parseOpenClawProcessTitle>>; pid: number }
  | undefined {
  const match = PROCESS_ANNOUNCEMENT_TITLE_PATTERN.exec(value);
  const processTitle = parseOpenClawProcessTitle(match?.groups?.title ?? "");
  const pid = Number(match?.groups?.pid);
  return processTitle && Number.isFinite(pid) && pid > 0 ? { processTitle, pid } : undefined;
}
