import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertNoSymlinkParents, readFileHandleBounded } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import { FsSafeError, root as fsSafeRoot, type OpenResult } from "../infra/fs-safe.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";
import { digestTemplateBytes } from "./digest.js";
import { readTemplateOpenClawProfile } from "./openclaw-profile.js";
import { isCanonicalClawHubPackageName, isExactSemVer } from "./schema-portability.js";
import { templateManifestWorkspaceConflictsWithPath, parseTemplateManifest } from "./schema.js";
import { templateWorkspaceSourceFailure } from "./source-diagnostics.js";
import {
  MAX_TEMPLATE_MANIFEST_BYTES,
  MAX_MANAGED_FILE_BYTES,
  MAX_MANAGED_WORKSPACE_BYTES,
} from "./source-limits.js";
import type {
  TemplateDiagnostic,
  TemplateManifest,
  TemplateReadResult,
  TemplateSourceIdentity,
  TemplateWorkspaceSourceSnapshot,
} from "./types.js";
import { parseTemplateYaml } from "./yaml-document.js";

type PackageJson = {
  name: string;
  version: string;
  openclaw: { template: string };
};

type ResolvedTemplateSource = Omit<
  TemplateSourceIdentity,
  "integrity" | "integrityKind" | "byteLength"
> & {
  packageJsonRaw?: Buffer;
  manifestFormatPath: string;
};

const TEMPLATE_MARKDOWN_FILENAME = "CLAW.md";
const MAX_TEMPLATE_PACKAGE_JSON_BYTES = 256 * 1024;

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const fileRoot = await fsSafeRoot(dirname(path));
  const read = await fileRoot.read(basename(path), {
    hardlinks: "reject",
    maxBytes,
    symlinks: "reject",
  });
  return read.buffer;
}

function fileDiagnostic(code: string, message: string, path = "$"): TemplateDiagnostic {
  return { level: "error", code, phase: "parse", path, message };
}

function fileFailure(code: string, message: string, path = "$") {
  return { ok: false as const, diagnostics: [fileDiagnostic(code, message, path)] };
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function updateSnapshotHash(
  hash: ReturnType<typeof createHash>,
  label: string,
  bytes: Buffer,
): void {
  hash.update(`${Buffer.byteLength(label, "utf8")}:${label}:${bytes.byteLength}:`, "utf8");
  hash.update(bytes);
}

function workspaceSourceDiagnostic(error: unknown, sourcePath: string): TemplateDiagnostic {
  const { code, message } = templateWorkspaceSourceFailure(error, sourcePath, "source");
  return fileDiagnostic(code, message, "$.workspace");
}

function parsePackageJson(
  value: unknown,
  allowPublishedLegacyClawSelector: boolean,
): PackageJson | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record = value;
  const openclaw = record.openclaw;
  if (!isRecord(openclaw)) {
    return undefined;
  }
  const canonical = Object.hasOwn(openclaw, "template");
  const legacy = Object.hasOwn(openclaw, "claw");
  if (canonical && legacy) {
    return undefined;
  }
  const template = canonical
    ? openclaw.template
    : allowPublishedLegacyClawSelector && legacy && openclaw.claw === TEMPLATE_MARKDOWN_FILENAME
      ? TEMPLATE_MARKDOWN_FILENAME
      : undefined;
  if (
    typeof record.name !== "string" ||
    !isCanonicalClawHubPackageName(record.name) ||
    typeof record.version !== "string" ||
    !isExactSemVer(record.version) ||
    typeof template !== "string" ||
    template.trim() === ""
  ) {
    return undefined;
  }
  return { name: record.name, version: record.version, openclaw: { template } };
}

export function parseTemplateMarkdown(
  raw: Buffer,
  path: string,
): { ok: true; value: unknown; body: Buffer } | { ok: false; diagnostics: TemplateDiagnostic[] } {
  const markdown =
    raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
      ? raw.subarray(3)
      : raw;
  const byteText = markdown.toString("latin1");
  const match = byteText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return fileFailure(
      "missing_template_frontmatter",
      `${path} must start with a YAML frontmatter block delimited by --- lines.`,
    );
  }
  const frontmatterBytes = Buffer.from(match[1] ?? "", "latin1");
  const body = markdown.subarray(match[0].length);
  let frontmatter: string;
  try {
    frontmatter = new TextDecoder("utf-8", { fatal: true }).decode(frontmatterBytes);
    new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return fileFailure("invalid_template_markdown_utf8", `${path} must contain valid UTF-8.`);
  }
  const parsed = parseTemplateYaml(frontmatter, path, "frontmatter");
  return parsed.ok ? { ...parsed, body } : parsed;
}

function parseTemplateManifestDocument(
  raw: Buffer,
  path: string,
): { ok: true; value: unknown; body?: Buffer } | { ok: false; diagnostics: TemplateDiagnostic[] } {
  if (basename(path).toLowerCase() === TEMPLATE_MARKDOWN_FILENAME.toLowerCase()) {
    return parseTemplateMarkdown(raw, path);
  }
  try {
    return { ok: true, value: JSON.parse(decodeUtf8Input(raw, path)) };
  } catch (error) {
    return fileFailure("invalid_json", `Could not parse ${path}: ${(error as Error).message}`);
  }
}

async function readTemplateDocument(
  path: string,
  code: string,
  maxBytes: number,
  manifestFormatPath = path,
): Promise<
  | { ok: true; raw: Buffer; value: unknown; body?: Buffer }
  | { ok: false; diagnostics: TemplateDiagnostic[] }
> {
  let raw: Buffer;
  try {
    raw = await readBoundedFile(path, maxBytes);
  } catch (error) {
    const tooLarge =
      error instanceof RangeError || (error instanceof FsSafeError && error.code === "too-large");
    return fileFailure(
      tooLarge ? `${code}_too_large` : code,
      tooLarge
        ? `${path} exceeds ${maxBytes} bytes.`
        : `Could not read ${path}: ${(error as Error).message}`,
    );
  }
  const parsed = parseTemplateManifestDocument(raw, manifestFormatPath);
  return parsed.ok ? { ...parsed, raw } : parsed;
}

async function resolvePackageSource(
  packageRoot: string,
  allowPublishedLegacyClawSelector: boolean,
): Promise<
  { ok: true; source: ResolvedTemplateSource } | { ok: false; diagnostics: TemplateDiagnostic[] }
> {
  const packageRootReal = await realpath(packageRoot).catch(() => undefined);
  if (!packageRootReal) {
    return fileFailure("package_read_failed", `Could not resolve ${packageRoot}.`);
  }
  const packageJsonPath = resolve(packageRootReal, "package.json");
  const packageJsonResult = await readTemplateDocument(
    packageJsonPath,
    "package_read_failed",
    MAX_TEMPLATE_PACKAGE_JSON_BYTES,
  );
  if (!packageJsonResult.ok) {
    return packageJsonResult;
  }
  const packageJson = parsePackageJson(packageJsonResult.value, allowPublishedLegacyClawSelector);
  if (!packageJson) {
    return fileFailure(
      "invalid_package_metadata",
      "package.json must declare non-empty name, version, and openclaw.template fields.",
    );
  }
  if (isAbsolute(packageJson.openclaw.template)) {
    return fileFailure("manifest_escapes_package", "openclaw.template must be package-relative.");
  }
  const declaredManifestPath = resolve(packageRootReal, packageJson.openclaw.template);
  const manifestPath = await realpath(declaredManifestPath).catch(() => undefined);
  if (!manifestPath || !isContained(packageRootReal, manifestPath)) {
    return fileFailure(
      "manifest_escapes_package",
      "The declared Template manifest must resolve inside its package root.",
    );
  }
  return {
    ok: true,
    source: {
      kind: "package",
      name: packageJson.name,
      version: packageJson.version,
      packageRoot: packageRootReal,
      manifestPath,
      packageJsonRaw: packageJsonResult.raw,
      manifestFormatPath: declaredManifestPath,
    },
  };
}

async function resolveSource(
  path: string,
  allowPublishedLegacyClawSelector: boolean,
): Promise<
  { ok: true; source: ResolvedTemplateSource } | { ok: false; diagnostics: TemplateDiagnostic[] }
> {
  const inputPath = resolve(path);
  const inputStat = await stat(inputPath).catch(() => undefined);
  if (!inputStat) {
    return fileFailure("read_failed", `Could not resolve Template source ${inputPath}.`);
  }
  if (inputStat.isDirectory()) {
    const sourceRoot = await fsSafeRoot(inputPath);
    if (
      !(await sourceRoot.exists("package.json")) &&
      (await sourceRoot.exists(TEMPLATE_MARKDOWN_FILENAME))
    ) {
      return resolveSource(
        resolve(inputPath, TEMPLATE_MARKDOWN_FILENAME),
        allowPublishedLegacyClawSelector,
      );
    }
    return resolvePackageSource(inputPath, allowPublishedLegacyClawSelector);
  }
  if (!inputStat.isFile()) {
    return fileFailure("unsupported_source", "Template source must be a file or directory.");
  }

  const manifestPath = await realpath(inputPath);
  const packageRoot = await realpath(dirname(manifestPath));
  return {
    ok: true,
    source: {
      kind: "development",
      name: `local:${basename(manifestPath).replace(/\.json$/i, "")}`,
      version: "0.0.0-development",
      packageRoot,
      manifestPath,
      manifestFormatPath: inputPath,
    },
  };
}

export async function readTemplateManifestFile(
  path: string,
  options: {
    /** Only the verified immutable registry-artifact owner enables this historical selector. */
    allowPublishedLegacyClawSelector?: boolean;
    allowLegacyDynamicToolProfile?: boolean;
    authorizeLegacyLocalUpdateHostSettings?: (params: {
      manifest: TemplateManifest;
      source: Pick<
        TemplateSourceIdentity,
        "kind" | "name" | "version" | "packageRoot" | "manifestPath"
      >;
    }) => boolean | Promise<boolean>;
  } = {},
): Promise<TemplateReadResult> {
  const sourceResult = await resolveSource(path, options.allowPublishedLegacyClawSelector === true);
  if (!sourceResult.ok) {
    return sourceResult;
  }
  const manifestResult = await readTemplateDocument(
    sourceResult.source.manifestPath,
    "read_failed",
    MAX_TEMPLATE_MANIFEST_BYTES,
    sourceResult.source.manifestFormatPath,
  );
  if (!manifestResult.ok) {
    return manifestResult;
  }
  const parsed = parseTemplateManifest(manifestResult.value);
  if (!parsed.ok) {
    return parsed;
  }
  const hasMarkdownBody =
    manifestResult.body !== undefined && manifestResult.body.toString("utf8").trim().length > 0;
  if (hasMarkdownBody && templateManifestWorkspaceConflictsWithPath(parsed.manifest, "SOUL.md")) {
    return fileFailure(
      "template_body_soul_conflict",
      "CLAW.md body content and an explicit SOUL.md workspace declaration cannot both be present.",
      "$.workspace",
    );
  }
  const legacyAuthorizationContext = {
    manifest: parsed.manifest,
    source: {
      kind: sourceResult.source.kind,
      name: sourceResult.source.name,
      version: sourceResult.source.version,
      packageRoot: sourceResult.source.packageRoot,
      manifestPath: sourceResult.source.manifestPath,
    },
  };
  const allowLegacyDynamicToolProfile = options.allowLegacyDynamicToolProfile === true;
  const allowLegacyLocalUpdateHostSettings = options.authorizeLegacyLocalUpdateHostSettings
    ? await options.authorizeLegacyLocalUpdateHostSettings(legacyAuthorizationContext)
    : false;
  const profile = await readTemplateOpenClawProfile({
    packageRoot: sourceResult.source.packageRoot,
    metadata: parsed.manifest.metadata,
    ...(allowLegacyDynamicToolProfile ? { allowLegacyDynamicToolProfile: true } : {}),
    ...(allowLegacyLocalUpdateHostSettings ? { allowLegacyLocalUpdateHostSettings: true } : {}),
  });
  if (!profile.ok) {
    return profile;
  }
  const resolvedSource = sourceResult.source;
  const hash = createHash("sha256");
  let byteLength = 0;
  const add = (label: string, bytes: Buffer) => {
    updateSnapshotHash(hash, label, bytes);
    byteLength += bytes.byteLength;
  };
  const snapshotFile = (bytes: Buffer) => ({
    byteLength: bytes.byteLength,
    digest: digestTemplateBytes(bytes),
  });
  const manifestSnapshot = snapshotFile(manifestResult.raw);
  const profileSnapshot =
    profile.raw && profile.path
      ? {
          sourcePath: profile.path.replaceAll("\\", "/"),
          ...snapshotFile(profile.raw),
        }
      : undefined;
  add("canonical-source", Buffer.from(resolvedSource.manifestPath, "utf8"));
  add("manifest", manifestResult.raw);
  if (profile.raw && profile.path) {
    add(`profile:${profile.path.replaceAll("\\", "/")}`, profile.raw);
  }

  if (resolvedSource.kind === "package") {
    const packageJson = resolvedSource.packageJsonRaw;
    if (!packageJson) {
      return fileFailure("package_read_failed", "Could not snapshot package.json.");
    }
    add("package.json", packageJson);
  }

  const sourceRoot = await fsSafeRoot(resolvedSource.packageRoot);
  let packageBootstrap: TemplateWorkspaceSourceSnapshot | undefined;
  if (await sourceRoot.exists("BOOTSTRAP.md")) {
    try {
      const read = await sourceRoot.read("BOOTSTRAP.md", {
        hardlinks: "reject",
        maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
        symlinks: "reject",
      });
      const text = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
      if (text.trim().length === 0) {
        return fileFailure(
          "package_bootstrap_empty",
          "Package-root BOOTSTRAP.md must contain first-run instructions.",
          "$.bootstrap",
        );
      }
      const digest = digestTemplateBytes(read.buffer);
      add("bootstrap:BOOTSTRAP.md", read.buffer);
      packageBootstrap = {
        sourcePath: "BOOTSTRAP.md",
        realPath: read.realPath,
        byteLength: read.buffer.byteLength,
        digest,
      };
    } catch (error) {
      const tooLarge = error instanceof FsSafeError && error.code === "too-large";
      return fileFailure(
        tooLarge ? "package_bootstrap_too_large" : "package_bootstrap_invalid",
        tooLarge
          ? `Package-root BOOTSTRAP.md exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes.`
          : `Package-root BOOTSTRAP.md must be a safe UTF-8 regular file: ${(error as Error).message}`,
        "$.bootstrap",
      );
    }
  }

  const declaredSources = [
    ...Object.values(parsed.manifest.workspace.bootstrapFiles)
      .filter((entry): entry is { source: string } => entry !== undefined)
      .map((entry) => entry.source),
    ...parsed.manifest.workspace.files.map((entry) => entry.source),
  ].toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  const openedSources: Array<{ sourcePath: string; opened: OpenResult }> = [];
  const workspaceSources: TemplateWorkspaceSourceSnapshot[] = [];
  try {
    let workspaceByteLength = 0;
    for (const sourcePath of declaredSources) {
      try {
        await assertNoSymlinkParents({
          rootDir: resolvedSource.packageRoot,
          targetPath: resolve(resolvedSource.packageRoot, sourcePath),
          allowMissing: false,
          messagePrefix: "Workspace source",
        });
        const opened = await sourceRoot.open(sourcePath, {
          hardlinks: "reject",
          symlinks: "reject",
        });
        if (opened.stat.size > MAX_MANAGED_FILE_BYTES) {
          await opened[Symbol.asyncDispose]();
          throw new FsSafeError(
            "too-large",
            `file exceeds limit of ${MAX_MANAGED_FILE_BYTES} bytes (got ${opened.stat.size})`,
          );
        }
        workspaceByteLength += opened.stat.size;
        openedSources.push({ sourcePath, opened });
      } catch (error) {
        return { ok: false, diagnostics: [workspaceSourceDiagnostic(error, sourcePath)] };
      }
    }

    if (workspaceByteLength > MAX_MANAGED_WORKSPACE_BYTES) {
      return fileFailure(
        "workspace_sources_too_large",
        `Workspace sources exceed ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`,
        "$.workspace",
      );
    }

    let readWorkspaceByteLength = 0;
    for (const { sourcePath, opened } of openedSources) {
      let bytes: Buffer;
      try {
        bytes = await readFileHandleBounded(opened.handle, MAX_MANAGED_FILE_BYTES);
      } catch (error) {
        if (error instanceof FsSafeError && error.code === "too-large") {
          return { ok: false, diagnostics: [workspaceSourceDiagnostic(error, sourcePath)] };
        }
        throw error;
      }
      readWorkspaceByteLength += bytes.byteLength;
      if (readWorkspaceByteLength > MAX_MANAGED_WORKSPACE_BYTES) {
        return fileFailure(
          "workspace_sources_too_large",
          `Workspace sources exceed ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`,
          "$.workspace",
        );
      }
      const digest = digestTemplateBytes(bytes);
      add(`workspace:${sourcePath}`, bytes);
      workspaceSources.push({
        sourcePath,
        realPath: opened.realPath,
        byteLength: bytes.byteLength,
        digest,
      });
    }
  } finally {
    await Promise.all(openedSources.map(({ opened }) => opened[Symbol.asyncDispose]()));
  }
  const source: TemplateSourceIdentity = {
    kind: resolvedSource.kind,
    name: resolvedSource.name,
    version: resolvedSource.version,
    packageRoot: resolvedSource.packageRoot,
    manifestPath: resolvedSource.manifestPath,
    integrityKind: "development-snapshot",
    integrity: `sha256:${hash.digest("hex")}`,
    byteLength,
  };
  return {
    ok: true,
    manifest: parsed.manifest,
    ...(hasMarkdownBody ? { templateMarkdownBody: manifestResult.body } : {}),
    ...(packageBootstrap ? { packageBootstrap } : {}),
    ...(profile.profile ? { openClawProfile: profile.profile } : {}),
    source,
    snapshot: {
      manifest: manifestSnapshot,
      ...(profileSnapshot ? { openClawProfile: profileSnapshot } : {}),
      workspaceSources,
      ...(packageBootstrap ? { packageBootstrap } : {}),
    },
    diagnostics: [...parsed.diagnostics, ...(profile.diagnostics ?? [])],
  };
}
