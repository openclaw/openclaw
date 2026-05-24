/**
 * Markdown formatters for the SecretRef credential surface reference doc
 * (`docs/reference/secretref-credential-surface.md`).
 *
 * The same registry data drives both the JSON matrix and the marker-block
 * Markdown lists, so generation and drift checks share a single source of
 * truth. Keep this module pure and dependency-free so it can be imported
 * from both the generator and tests without bringing the wider runtime in.
 *
 * See `scripts/generate-secretref-credential-matrix.ts` for the writer and
 * `src/secrets/target-registry.docs.test.ts` for the drift check.
 */

import type {
  CredentialMatrixEntry,
  SecretRefCredentialMatrixDocument,
} from "./credential-matrix.js";

const SIBLING_REF_NOTE = `Compatibility exception: sibling ref field remains canonical.`;
const AUTH_PROFILES_HEADING = `### \`auth-profiles.json\` targets (\`secrets configure\` + \`secrets apply\` + \`secrets audit\`)`;

function renderOpenClawSupportedLine(entry: CredentialMatrixEntry): string {
  if (entry.secretShape === "sibling_ref" && entry.refPath && entry.notes === SIBLING_REF_NOTE) {
    const refLeaf = entry.refPath.split(".").at(-1) ?? entry.refPath;
    return `- \`${entry.path}\` via sibling \`${refLeaf}\` (compatibility exception)`;
  }
  return `- \`${entry.path}\``;
}

function renderAuthProfileSupportedLine(entry: CredentialMatrixEntry): string {
  const refPath = entry.refPath ?? entry.path;
  const whenType = entry.when?.type ?? "unknown";
  return `- \`${refPath}\` (\`type: "${whenType}"\`; unsupported when \`auth.profiles.<id>.mode = "oauth"\`)`;
}

/**
 * Produces the Markdown body for the
 * `[//]: # "secretref-supported-list-start"` / `..."-end"` block, excluding
 * the marker comments themselves.
 *
 * The body always begins and ends with a blank line so it slots cleanly
 * between the marker comments without leaving them flush against list
 * items. Entries are deterministically ordered by id within each
 * subsection.
 */
export function formatSecretRefSupportedListMarkdown(
  matrix: SecretRefCredentialMatrixDocument,
): string {
  const openClawEntries: CredentialMatrixEntry[] = [];
  const authProfileEntries: CredentialMatrixEntry[] = [];
  for (const entry of matrix.entries) {
    if (entry.configFile === "auth-profiles.json") {
      authProfileEntries.push(entry);
    } else {
      openClawEntries.push(entry);
    }
  }
  openClawEntries.sort((a, b) => a.id.localeCompare(b.id));
  authProfileEntries.sort((a, b) => a.id.localeCompare(b.id));

  const lines: string[] = [];
  lines.push("");
  lines.push("");
  for (const entry of openClawEntries) {
    lines.push(renderOpenClawSupportedLine(entry));
  }
  if (authProfileEntries.length > 0) {
    lines.push("");
    lines.push(AUTH_PROFILES_HEADING);
    lines.push("");
    for (const entry of authProfileEntries) {
      lines.push(renderAuthProfileSupportedLine(entry));
    }
  }
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

/**
 * Produces the Markdown body for the
 * `[//]: # "secretref-unsupported-list-start"` / `..."-end"` block.
 *
 * The body always begins and ends with a blank line. Entries preserve
 * registry order via `excludedMutableOrRuntimeManaged`.
 */
export function formatSecretRefUnsupportedListMarkdown(
  matrix: SecretRefCredentialMatrixDocument,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("");
  for (const pattern of matrix.excludedMutableOrRuntimeManaged) {
    lines.push(`- \`${pattern}\``);
  }
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

/**
 * Replaces the body between two marker lines in the source markdown.
 *
 * The replacement preserves the marker comments themselves; only the
 * content strictly between them is rewritten. Throws when either marker
 * is missing or when the start marker appears after the end marker, so
 * silent doc corruption is impossible.
 */
export function replaceMarkedBlock(
  source: string,
  params: { startMarker: string; endMarker: string; body: string },
): string {
  const startIndex = source.indexOf(params.startMarker);
  if (startIndex < 0) {
    throw new Error(`replaceMarkedBlock: start marker not found: ${params.startMarker}`);
  }
  const endIndex = source.indexOf(params.endMarker, startIndex + params.startMarker.length);
  if (endIndex < 0) {
    throw new Error(`replaceMarkedBlock: end marker not found: ${params.endMarker}`);
  }
  const head = source.slice(0, startIndex + params.startMarker.length);
  const tail = source.slice(endIndex);
  return `${head}${params.body}${tail}`;
}
