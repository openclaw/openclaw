import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { realpathOrResolve } from "../infra/path-existence.js";
import { relativePathEscapesRoot } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import {
  MediaReferenceError,
  normalizeMediaReferenceSource,
  parseInboundMediaUri,
} from "./inbound-media-uri.js";
import { MAX_GROUNDING_PATHS } from "./media-grounding-limits.js";
import { getMediaDir, resolveMediaBufferPath } from "./store.js";

export {
  MediaReferenceError,
  normalizeMediaReferenceSource,
  parseInboundMediaUri,
} from "./inbound-media-uri.js";

const MAX_GROUNDING_ALIASES = MAX_GROUNDING_PATHS * 16,
  MAX_GROUNDING_REFERENCE_CHARS = 4_096;
// `parseInboundMediaUri` resolves only this host, so it is the one managed URI root.
const INBOUND_MEDIA_URI_ROOT = "media://inbound";

/** Classifies media reference schemes before local resolution or sandbox rewriting. */
export function classifyMediaReferenceSource(
  source: string,
  options?: { allowDataUrl?: boolean },
): {
  hasUnsupportedScheme: boolean;
  isDataUrl: boolean;
  isFileUrl: boolean;
  isHttpUrl: boolean;
  isMediaStoreUrl: boolean;
  looksLikeWindowsDrivePath: boolean;
} {
  const allowDataUrl = options?.allowDataUrl ?? true;
  const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(source);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(source);
  const isFileUrl = /^file:/i.test(source);
  const isHttpUrl = hasHttpUrlPrefix(source);
  const isDataUrl = /^data:/i.test(source);
  const isMediaStoreUrl = /^media:\/\//i.test(source);
  const hasUnsupportedScheme =
    hasScheme &&
    !looksLikeWindowsDrivePath &&
    !isFileUrl &&
    !isHttpUrl &&
    !isMediaStoreUrl &&
    !(allowDataUrl && isDataUrl);
  return {
    hasUnsupportedScheme,
    isDataUrl,
    isFileUrl,
    isHttpUrl,
    isMediaStoreUrl,
    looksLikeWindowsDrivePath,
  };
}

function maybeLocalPathFromSource(source: string): string | null {
  if (/^file:/i.test(source)) {
    try {
      return safeFileURLToPath(source);
    } catch {
      return null;
    }
  }
  if (source.startsWith("~")) {
    return resolveUserPath(source);
  }
  if (path.isAbsolute(source)) {
    return source;
  }
  return null;
}

/** Converts a managed inbound path to a URI without exposing paths outside its store. */
export function buildInboundMediaUriFromPath(source: string): string | undefined {
  const localPath = maybeLocalPathFromSource(source.trim());
  if (!localPath) {
    return undefined;
  }
  const inboundDir = path.resolve(getMediaDir(), "inbound");
  const relativePath = path.relative(inboundDir, path.resolve(localPath));
  // The inbound id must be a single path component that does not escape the store bucket;
  // reject traversal, nested segments, and absolute/empty results.
  if (
    !relativePath ||
    relativePathEscapesRoot(relativePath) ||
    relativePath.includes(path.sep) ||
    relativePath.includes("\\")
  ) {
    return undefined;
  }
  try {
    const parsed = parseInboundMediaUri(`media://inbound/${relativePath}`);
    return parsed?.normalizedSource;
  } catch {
    // Malformed percent-encoded ids (e.g. a stray `%`) make the URI decoder throw;
    // redact instead of propagating the failure into the shared history projection.
    return undefined;
  }
}

/** Rewrites inbound media-store URIs to sandbox-relative paths for staged agent inputs. */
export function resolveMediaReferenceSandboxPath(
  source: string,
  inboundDir = "media/inbound",
): { resolved: string; rewrittenFrom?: string } {
  const normalizedSource = normalizeMediaReferenceSource(source);
  const uri = parseInboundMediaUri(normalizedSource);
  if (!uri) {
    return { resolved: normalizedSource };
  }
  return {
    resolved: path.posix.join(inboundDir.replace(/\\/g, "/"), uri.id),
    rewrittenFrom: uri.normalizedSource,
  };
}

/** Resolves inbound media:// URIs or first-level inbound file paths to concrete store files. */
export async function resolveInboundMediaReference(source: string): Promise<{
  id: string;
  physicalPath: string;
} | null> {
  const normalizedSource = normalizeMediaReferenceSource(source);
  if (!normalizedSource) {
    return null;
  }

  const uri = parseInboundMediaUri(normalizedSource);
  if (uri) {
    return {
      id: uri.id,
      physicalPath: await resolveInboundMediaPath(uri.id, uri.normalizedSource),
    };
  }

  const localPath = maybeLocalPathFromSource(normalizedSource);
  if (!localPath) {
    return null;
  }

  const rawInboundDir = path.resolve(getMediaDir(), "inbound");
  const rawResolvedPath = path.resolve(localPath);
  const rawRel = path.relative(rawInboundDir, rawResolvedPath);
  // Realpath fallback catches symlinks and moved state dirs before accepting direct paths.
  const rel =
    rawRel && !relativePathEscapesRoot(rawRel)
      ? rawRel
      : path.relative(await realpathOrResolve(rawInboundDir), await realpathOrResolve(localPath));
  if (!rel || relativePathEscapesRoot(rel) || rel.includes(path.sep)) {
    return null;
  }

  return {
    id: rel,
    physicalPath: await resolveInboundMediaPath(rel, normalizedSource),
  };
}

/** Resolves a media reference while preserving whether it belongs to the inbound store. */
export async function resolveMediaReferenceLocalPathInfo(source: string) {
  const normalizedSource = normalizeMediaReferenceSource(source);
  const inboundReference = await resolveInboundMediaReference(normalizedSource);
  return inboundReference
    ? { kind: "inbound" as const, path: inboundReference.physicalPath }
    : { kind: "local" as const, path: normalizedSource };
}

/** Converts inbound media references for callers that need a direct local file path. */
export async function resolveMediaReferenceLocalPath(source: string): Promise<string> {
  return (await resolveMediaReferenceLocalPathInfo(source)).path;
}

async function resolveInboundMediaPath(id: string, source: string): Promise<string> {
  try {
    return await resolveMediaBufferPath(id, "inbound");
  } catch (err) {
    throw new MediaReferenceError(
      "invalid-path",
      err instanceof Error ? err.message : `Invalid media reference: ${source}`,
      { cause: err },
    );
  }
}

export type ManagedMediaGrounding = {
  readonly authorizedAliases: readonly string[];
  readonly caseInsensitivePaths: boolean;
  /** Where `maybeLocalPathFromSource` expands a leading `~`, through `resolveUserPath`. */
  readonly homeDir: string;
  readonly rootAliases: readonly string[];
  /** Lowercase media-store URI roots; URI schemes match case-insensitively. */
  readonly uriRoots: readonly string[];
};

export type ManagedMediaGroundingRoot = Omit<ManagedMediaGrounding, "authorizedAliases"> & {
  readonly mediaDir: string;
};

async function resolveManagedMediaPath(
  candidate: string,
  mediaDir: string,
): Promise<string | undefined> {
  const relative = path.relative(mediaDir, candidate);
  if (!relative || relativePathEscapesRoot(relative)) {
    return undefined;
  }
  const subdir = path.dirname(relative);
  return await resolveMediaBufferPath(path.basename(relative), subdir === "." ? "" : subdir).catch(
    () => undefined,
  );
}

function prepareManagedMediaPathAliases(value: string, target = new Set<string>()): Set<string> {
  if (!value || value.length > MAX_GROUNDING_REFERENCE_CHARS) {
    return target;
  }
  const add = (alias: string) => {
    if (target.size < MAX_GROUNDING_ALIASES && alias.length <= MAX_GROUNDING_REFERENCE_CHARS) {
      target.add(alias);
    }
  };
  let slash = value.replaceAll("\\", "/").replace(/\/$/u, "");
  if (/^\/\/\?\/unc\//i.test(slash)) {
    slash = `//${slash.slice("//?/UNC/".length)}`;
  } else if (/^\/\/\?\/[a-z]:\//i.test(slash)) {
    slash = slash.slice("//?/".length);
  }
  add(value);
  add(slash);
  if (/^[a-z]:\//i.test(slash)) {
    const [drive, ...segments] = slash.split("/");
    const encoded = [drive, ...segments.map(encodeURIComponent)].join("/");
    add(slash.replaceAll("/", "\\"));
    add(`//?/${slash}`);
    add(`\\\\?\\${slash.replaceAll("/", "\\")}`);
    add(`file:///${encoded}`);
  } else if (slash.startsWith("//")) {
    const unc = slash.slice(2);
    const [host, ...segments] = unc.split("/");
    add(slash.replaceAll("/", "\\"));
    add(`//?/UNC/${unc}`);
    add(`\\\\?\\UNC\\${unc.replaceAll("/", "\\")}`);
    add(`file://${host}/${segments.map(encodeURIComponent).join("/")}`);
  } else if (slash.startsWith("/")) {
    const values = slash.startsWith("/private/var/")
      ? [slash, slash.slice("/private".length)]
      : slash.startsWith("/var/")
        ? [slash, `/private${slash}`]
        : [slash];
    for (const local of values) {
      const pathname = pathToFileURL(local).pathname;
      add(local);
      add(`file:${pathname.slice(1)}`);
      add(`file:${pathname}`);
      add(`file://${pathname}`);
      add(`file:///${pathname}`);
      add(`file://localhost${pathname}`);
      add(`file://localhost/${pathname}`);
    }
  }
  return target;
}

async function probeCaseInsensitivePath(value: string): Promise<boolean> {
  const base = path.basename(value);
  const toggled = base.replace(/[a-z]/i, (char) =>
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
  );
  if (toggled === base) {
    return false;
  }
  const original = await fs.stat(value).catch(() => undefined);
  const alias = await fs.stat(path.join(path.dirname(value), toggled)).catch(() => undefined);
  return Boolean(original && alias && original.dev === alias.dev && original.ino === alias.ino);
}

/** Prepares immutable media-root identity once for every replay operation. */
export async function prepareManagedMediaGroundingRoot(): Promise<ManagedMediaGroundingRoot> {
  const rootAliases = new Set<string>();
  const mediaDir = getMediaDir();
  const realMediaDir = await fs.realpath(mediaDir).catch(() => mediaDir);
  const homeDir = resolveUserPath("~");
  for (const dir of [mediaDir, realMediaDir]) {
    prepareManagedMediaPathAliases(dir, rootAliases);
    const fromHome = path.relative(homeDir, dir);
    if (fromHome && !relativePathEscapesRoot(fromHome)) {
      prepareManagedMediaPathAliases(`~${path.sep}${fromHome}`, rootAliases);
    }
  }
  const byLength = (left: string, right: string) => right.length - left.length;
  return {
    caseInsensitivePaths: await probeCaseInsensitivePath(realMediaDir),
    homeDir,
    mediaDir,
    rootAliases: [...rootAliases].toSorted(byLength),
    uriRoots: [INBOUND_MEDIA_URI_ROOT],
  };
}

/** The real path of the managed file `source` opens, read as every media consumer reads it. */
async function verifiedManagedPath(
  root: ManagedMediaGroundingRoot,
  source: string,
): Promise<string | undefined> {
  const inbound = await resolveInboundMediaReference(source).catch(() => null);
  if (inbound) {
    return inbound.physicalPath;
  }
  const localPath = maybeLocalPathFromSource(source);
  return localPath ? await resolveManagedMediaPath(localPath, root.mediaDir) : undefined;
}

/**
 * The `spellings` that open a managed file none of `grounding`'s verified paths names. The
 * transcript scan cannot tell `ok.png<TAB>.fake` from prose without the store. Spellings past
 * the probe budget are reported unread.
 */
export async function findUnverifiedJoinedMediaSpellings(
  root: ManagedMediaGroundingRoot,
  grounding: ManagedMediaGrounding,
  spellings: Iterable<string>,
): Promise<Set<string>> {
  const authorized = new Set(grounding.authorizedAliases);
  const unverified = new Set<string>();
  let probes = 0;
  for (const spelling of spellings) {
    if (probes >= MAX_GROUNDING_PATHS) {
      unverified.add(spelling);
      continue;
    }
    probes += 1;
    const verified = await verifiedManagedPath(root, normalizeMediaReferenceSource(spelling));
    if (verified && !authorized.has(verified)) {
      unverified.add(spelling);
    }
  }
  return unverified;
}

/** The path `source` names before any link is followed, built as the resolver builds it. */
function unresolvedManagedPath(root: ManagedMediaGroundingRoot, source: string) {
  let uri: ReturnType<typeof parseInboundMediaUri>;
  try {
    uri = parseInboundMediaUri(source);
  } catch {
    return undefined;
  }
  if (uri) {
    return path.join(root.mediaDir, "inbound", uri.id);
  }
  const localPath = maybeLocalPathFromSource(source);
  return localPath ? path.resolve(localPath) : undefined;
}

const foldEntryName = (name: string) => name.normalize("NFC").toLowerCase();

/** An authorized alias that more text follows, and the places a reader could end a name there. */
type MediaContinuation<K> = {
  key: K;
  /** The alias as the text spells it. */
  alias: string;
  /** Undefined when the text ran past what the scan can read. */
  spellings: () => Iterable<string> | undefined;
};

type ContinuationDirectory = { directory: string; own: string; names: ReadonlySet<string> };

/**
 * The keys of `continuations` whose text can open a managed file no same-turn reference
 * verified. Text after an authorized alias can run its name on across characters the resolver
 * keeps (`ok.png .fake`), and only a reader decides where it stops. A file opened that way sits in
 * the alias's directory under a name that begins with the alias's file name (the scan already
 * refuses one a later `..` carries elsewhere), so spellings are read only when that directory
 * lists one, and prose is never probed otherwise. The resolver's own parsers place each spelling,
 * and only one placed on another listed name, or outside the directory, is opened. Names compare
 * with case and Unicode form folded. A failed listing, unread text, or either budget running out
 * refuses.
 */
export async function findRefusedMediaContinuations<K>(
  root: ManagedMediaGroundingRoot,
  grounding: ManagedMediaGrounding,
  continuations: Iterable<MediaContinuation<K>>,
): Promise<Set<K>> {
  const authorized = new Set(grounding.authorizedAliases);
  const listings = new Map<string, Promise<Set<string> | undefined>>();
  const directories = new Map<string, Promise<ContinuationDirectory | null | undefined>>();
  const listed = async (alias: string) => {
    const target = unresolvedManagedPath(root, normalizeMediaReferenceSource(alias));
    if (target === undefined) {
      return undefined;
    }
    const directory = path.dirname(target);
    let listing = listings.get(directory);
    if (!listing) {
      listing = fs.readdir(directory).then(
        (entries) => new Set(entries.map(foldEntryName)),
        () => undefined,
      );
      listings.set(directory, listing);
    }
    const names = await listing;
    const own = foldEntryName(path.basename(target));
    if (!names) {
      return undefined;
    }
    // null: nothing in the directory extends the name, so no spelling can open another file.
    return [...names].some((name) => name.length > own.length && name.startsWith(own))
      ? { directory, own, names }
      : null;
  };
  const refused = new Set<K>();
  let placed = 0;
  let probes = 0;
  for (const { key, alias, spellings } of continuations) {
    let pending = directories.get(alias);
    if (!pending) {
      pending = listed(alias);
      directories.set(alias, pending);
    }
    const listing = await pending;
    if (listing === null) {
      continue;
    }
    const readable = listing && placed < MAX_GROUNDING_ALIASES ? spellings() : undefined;
    if (!listing || !readable) {
      refused.add(key);
      continue;
    }
    for (const spelling of readable) {
      if ((placed += 1) > MAX_GROUNDING_ALIASES) {
        refused.add(key);
        break;
      }
      const source = normalizeMediaReferenceSource(spelling);
      const opened = unresolvedManagedPath(root, source);
      if (opened === undefined) {
        continue;
      }
      const relative = path.relative(listing.directory, opened);
      const name = foldEntryName(relative.split(path.sep)[0] ?? "");
      if (
        !relativePathEscapesRoot(relative) &&
        (name === listing.own || !listing.names.has(name))
      ) {
        continue;
      }
      if ((probes += 1) > MAX_GROUNDING_PATHS) {
        refused.add(key);
        break;
      }
      const verified = await verifiedManagedPath(root, source);
      if (verified && !authorized.has(verified)) {
        refused.add(key);
        break;
      }
    }
  }
  return refused;
}

/** Resolves one entry's bounded references against prepared media-root identity. */
export async function prepareManagedMediaGrounding(
  root: ManagedMediaGroundingRoot,
  references: readonly string[],
): Promise<ManagedMediaGrounding> {
  const authorizedAliases = new Set<string>();
  for (const raw of references.slice(0, MAX_GROUNDING_PATHS)) {
    const source = normalizeMediaReferenceSource(raw);
    if (
      !source ||
      source.length > MAX_GROUNDING_REFERENCE_CHARS ||
      (/^file:/i.test(source) && /[?#]/u.test(source))
    ) {
      continue;
    }
    const verified = await verifiedManagedPath(root, source);
    if (!verified) {
      continue;
    }
    prepareManagedMediaPathAliases(source, authorizedAliases);
    prepareManagedMediaPathAliases(verified, authorizedAliases);
  }
  const byLength = (left: string, right: string) => right.length - left.length;
  return {
    authorizedAliases: [...authorizedAliases].toSorted(byLength),
    caseInsensitivePaths: root.caseInsensitivePaths,
    homeDir: root.homeDir,
    rootAliases: root.rootAliases,
    uriRoots: root.uriRoots,
  };
}
