import JSON5 from "json5";
import fs from "node:fs";
import type { ObaKeyFile } from "./keys.js";
import type { ObaBlock } from "./types.js";
import { base64UrlEncode } from "./base64url.js";
import { preparePayloadForSigning } from "./canonicalize.js";
import { signPayload } from "./keys.js";
import { validateOwnerUrl } from "./owner-url.js";

function buildObaBlock(key: ObaKeyFile, ownerOverride?: string): Omit<ObaBlock, "sig"> {
  const owner = ownerOverride ?? key.owner;
  if (!owner) {
    throw new Error("No owner URL. Provide --owner or set it during keygen.");
  }
  const urlResult = validateOwnerUrl(owner);
  if (!urlResult.ok) {
    throw new Error(`Invalid owner URL: ${urlResult.error}`);
  }
  return { owner, kid: key.kid, alg: "EdDSA" };
}

function signContainer(
  container: Record<string, unknown>,
  key: ObaKeyFile,
  ownerOverride?: string,
): { container: Record<string, unknown>; kid: string; sig: string } {
  const obaPartial = buildObaBlock(key, ownerOverride);

  // Inject oba block without sig for payload preparation.
  // preparePayloadForSigning deep-clones internally, so we work on the original
  // here and only clone once for the final signed output.
  const withOba = { ...container, oba: { ...obaPartial } };

  const payload = preparePayloadForSigning(withOba);
  const sigBytes = signPayload(payload, key.privateKeyPem);
  const sig = base64UrlEncode(sigBytes);

  // Build final container with the signed oba block.
  const signed = { ...container, oba: { ...obaPartial, sig } };

  return { container: signed, kid: key.kid, sig };
}

export function signPluginManifest(params: {
  manifestPath: string;
  key: ObaKeyFile;
  ownerOverride?: string;
}): { kid: string; sig: string } {
  const raw = fs.readFileSync(params.manifestPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const { container, kid, sig } = signContainer(parsed, params.key, params.ownerOverride);

  fs.writeFileSync(params.manifestPath, `${JSON.stringify(container, null, 2)}\n`, "utf-8");
  return { kid, sig };
}

// Frontmatter regex — normalize CRLF before matching.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Extract the metadata JSON5 string and its byte offsets from a SKILL.md frontmatter block.
 * Exported so the verify-after-sign path in oba-cli.ts can reuse it.
 */
export function extractSkillMetadata(content: string): {
  metadataRaw: string;
  metaStart: number;
  metaEnd: number;
} {
  // Normalize CRLF to LF for consistent parsing.
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const fmMatch = normalized.match(FRONTMATTER_RE);
  if (!fmMatch || fmMatch.index === undefined) {
    throw new Error("No frontmatter block found");
  }
  const fmBlock = fmMatch[1];
  // Use match index + 4 (length of "---\n") to get the exact position of the
  // frontmatter content, instead of indexOf which could match earlier content.
  const fmBlockStart = fmMatch.index + 4;

  // Anchor to line start to avoid matching substrings like "extra_metadata:".
  const metaKeyMatch = /^metadata:/m.exec(fmBlock);
  if (!metaKeyMatch) {
    throw new Error("No metadata field found in frontmatter");
  }
  const metaKeyIndex = metaKeyMatch.index;

  const metaValueStart = metaKeyIndex + "metadata:".length;
  const remainingLines = fmBlock.slice(metaValueStart).split("\n");
  const valueLines: string[] = [];
  let firstLine = true;
  for (const line of remainingLines) {
    if (firstLine) {
      valueLines.push(line);
      firstLine = false;
      continue;
    }
    // A non-indented, non-empty line with "key:" pattern means next field.
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t") && /^\w/.test(line)) {
      break;
    }
    valueLines.push(line);
  }
  const metadataRaw = valueLines.join("\n").trim();
  const metaAbsStart = fmBlockStart + metaKeyIndex;
  const metaAbsEnd = fmBlockStart + metaValueStart + valueLines.join("\n").length;

  return {
    metadataRaw,
    metaStart: metaAbsStart,
    metaEnd: metaAbsEnd,
  };
}

/**
 * Parse skill metadata JSON5 from a SKILL.md content string.
 * Shared between sign and verify paths to avoid parser divergence.
 */
export function parseSkillMetadataObject(content: string): Record<string, unknown> {
  const { metadataRaw } = extractSkillMetadata(content);
  const parsed = JSON5.parse(metadataRaw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid metadata JSON5");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Sign a SKILL.md file. The metadata is in the frontmatter block between `---` markers.
 * We parse the metadata JSON5 object, sign it, then replace it back in the file.
 */
export function signSkillMetadata(params: {
  skillPath: string;
  key: ObaKeyFile;
  ownerOverride?: string;
}): { kid: string; sig: string } {
  const raw = fs.readFileSync(params.skillPath, "utf-8");
  // extractSkillMetadata normalizes CRLF internally and returns offsets into
  // the normalized string, so we normalize once here to keep splice offsets valid.
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const { metadataRaw, metaStart, metaEnd } = extractSkillMetadata(normalized);

  const parsed = JSON5.parse(metadataRaw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid metadata JSON5 in ${params.skillPath}`);
  }

  const { container: signed, kid, sig } = signContainer(parsed, params.key, params.ownerOverride);

  // Serialize back as JSON with 2-space indent.
  const serialized = JSON.stringify(signed, null, 2);

  // Index-based splice to avoid String.replace pitfalls with $ sequences.
  const newContent =
    normalized.slice(0, metaStart) + `metadata: ${serialized}` + normalized.slice(metaEnd);

  fs.writeFileSync(params.skillPath, newContent, "utf-8");
  return { kid, sig };
}
