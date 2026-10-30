import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, parse, resolve } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { templateContainedRelativePath } from "./path-containment.js";
import { readTemplateManifestFile } from "./reader.js";
import { isCanonicalClawHubPackageName, portableTemplatePathKey } from "./schema-portability.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";
import type { TemplateDiagnostic, TemplateReadResult } from "./types.js";

export const TEMPLATE_PROJECT_RESULT_SCHEMA_VERSION = "openclaw.templateProject.v1" as const;

const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_PROJECT_ENTRIES = 4096;
const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

type TemplateProjectPackageJson = {
  name: string;
  version: string;
  type?: string;
  license?: string;
  openclaw: { template: "CLAW.md" };
};

type TemplateProjectValidationResult =
  | {
      ok: true;
      root: string;
      packageJson: TemplateProjectPackageJson;
      template: Extract<TemplateReadResult, { ok: true }>;
      license?: { byteLength: number; digest: string };
      excludedPaths: string[];
      diagnostics: TemplateDiagnostic[];
    }
  | { ok: false; root: string; diagnostics: TemplateDiagnostic[] };

export class TemplateProjectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TemplateProjectError";
  }
}

function diagnostic(code: string, path: string, message: string): TemplateDiagnostic {
  return { level: "error", code, phase: "policy", path, message };
}

function defaultSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 64);
  return slug || "my-template";
}

function displayName(agentId: string): string {
  return agentId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

async function pathState(path: string): Promise<"missing" | "empty-directory" | "occupied"> {
  const entry = await lstat(path).catch(() => undefined);
  if (!entry) {
    return "missing";
  }
  if (!entry.isDirectory()) {
    return "occupied";
  }
  return (await readdir(path)).length === 0 ? "empty-directory" : "occupied";
}

async function isFile(path: string): Promise<boolean> {
  return lstat(path)
    .then((entry) => entry.isFile())
    .catch(() => false);
}

async function isConfinedManifestFile(root: string): Promise<boolean> {
  const manifestPath = resolve(root, "CLAW.md");
  const entry = await lstat(manifestPath).catch(() => undefined);
  if (entry?.isFile()) {
    return true;
  }
  if (!entry?.isSymbolicLink()) {
    return false;
  }
  const [rootReal, targetReal] = await Promise.all([
    realpath(root).catch(() => undefined),
    realpath(manifestPath).catch(() => undefined),
  ]);
  if (!rootReal || !targetReal) {
    return false;
  }
  const targetRelative = templateContainedRelativePath(rootReal, targetReal);
  if (!targetRelative || isExcludedProjectSource(targetRelative)) {
    return false;
  }
  return isFile(targetReal);
}

async function discoverTemplateProjectRoot(projectPath: string): Promise<string> {
  const input = resolve(projectPath);
  const inputStat = await lstat(input).catch(() => undefined);
  if (!inputStat) {
    throw new TemplateProjectError(
      "project_not_found",
      `Could not resolve Template project path ${JSON.stringify(input)}.`,
    );
  }
  let current = inputStat.isDirectory() ? input : dirname(input);
  const roots: string[] = [];
  const filesystemRoot = parse(current).root;
  while (true) {
    if (
      (await isFile(resolve(current, "package.json"))) &&
      (await isConfinedManifestFile(current))
    ) {
      roots.push(await realpath(current));
    }
    if (current === filesystemRoot) {
      break;
    }
    current = dirname(current);
  }
  if (roots.length === 0) {
    throw new TemplateProjectError(
      "project_not_found",
      `No Template project containing package.json and CLAW.md was found from ${JSON.stringify(input)}.`,
    );
  }
  if (roots.length > 1) {
    throw new TemplateProjectError(
      "ambiguous_project_root",
      `Multiple Template project roots contain ${JSON.stringify(input)}: ${roots.join(", ")}.`,
    );
  }
  return roots[0] as string;
}

function projectPathKey(value: string, caseInsensitive: boolean): string {
  const normalized = value.normalize("NFC");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isExcludedProjectSource(value: string): boolean {
  return portableTemplatePathKey(value)
    .split("/")
    .some((segment) => segment === ".git" || segment === "node_modules");
}

export async function createTemplateProject(
  projectPath: string,
  options: { name?: string; agentId?: string } = {},
): Promise<{ root: string; packageJson: TemplateProjectPackageJson; filesWritten: string[] }> {
  const root = resolve(projectPath);
  const initialState = await pathState(root);
  if (initialState === "occupied") {
    throw new TemplateProjectError(
      "project_target_not_empty",
      `Template project target ${JSON.stringify(root)} must be absent or empty.`,
    );
  }

  const agentId = options.agentId ?? defaultSlug(basename(root));
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new TemplateProjectError(
      "invalid_agent_id",
      `Agent id ${JSON.stringify(agentId)} must match ${AGENT_ID_PATTERN}.`,
    );
  }
  const name = options.name ?? agentId;
  if (!isCanonicalClawHubPackageName(name)) {
    throw new TemplateProjectError(
      "invalid_package_name",
      `Package name ${JSON.stringify(name)} must be a valid ClawHub package name.`,
    );
  }

  const packageJson: TemplateProjectPackageJson = {
    name,
    version: "0.1.0",
    openclaw: { template: "CLAW.md" },
  };
  const templateMarkdown = [
    "---",
    "schemaVersion: 1",
    "agent:",
    `  id: ${JSON.stringify(agentId)}`,
    `  name: ${JSON.stringify(displayName(agentId))}`,
    "---",
    `You are ${displayName(agentId)}, a purpose-built OpenClaw agent.`,
    "",
  ].join("\n");

  const packageJsonPath = resolve(root, "package.json");
  const templateMarkdownPath = resolve(root, "CLAW.md");
  const createdPaths: string[] = [];
  await mkdir(root, { recursive: true });
  try {
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    createdPaths.push(packageJsonPath);
    await writeFile(templateMarkdownPath, templateMarkdown, { encoding: "utf8", flag: "wx" });
    createdPaths.push(templateMarkdownPath);
  } catch (error) {
    await Promise.allSettled(createdPaths.map((path) => unlink(path)));
    if (initialState === "missing") {
      await rmdir(root).catch(() => undefined);
    }
    throw error;
  }
  return { root, packageJson, filesWritten: ["package.json", "CLAW.md"] };
}

export async function validateTemplateProject(
  projectPath: string,
): Promise<TemplateProjectValidationResult> {
  let root = resolve(projectPath);
  const failure = (
    code: string,
    path: string,
    message: string,
  ): TemplateProjectValidationResult => ({
    ok: false,
    root,
    diagnostics: [diagnostic(code, path, message)],
  });
  try {
    root = await discoverTemplateProjectRoot(projectPath);
  } catch (error) {
    return failure(
      error instanceof TemplateProjectError ? error.code : "project_discovery_failed",
      "$",
      coerceErrorMessage(error),
    );
  }
  let packageValue: unknown;
  try {
    const sourceRoot = await fsSafeRoot(root);
    const read = await sourceRoot.read("package.json", {
      hardlinks: "reject",
      maxBytes: MAX_PACKAGE_JSON_BYTES,
      symlinks: "reject",
    });
    packageValue = JSON.parse(read.buffer.toString("utf8"));
  } catch (error) {
    return failure(
      "invalid_project_package",
      "package.json",
      `Could not read a safe project package.json: ${(error as Error).message}`,
    );
  }

  const record = asOptionalRecord(packageValue);
  const openclaw = asOptionalRecord(record?.openclaw);
  const scripts = record?.scripts;
  const diagnostics: TemplateDiagnostic[] = [];
  if (openclaw?.template !== "CLAW.md") {
    diagnostics.push(
      diagnostic(
        "project_manifest_must_be_template_markdown",
        "package.json.openclaw.template",
        'A Template project must set openclaw.template to "CLAW.md".',
      ),
    );
  }
  if (
    scripts !== undefined &&
    (typeof scripts !== "object" ||
      scripts === null ||
      Array.isArray(scripts) ||
      Object.keys(scripts).length > 0)
  ) {
    diagnostics.push(
      diagnostic(
        "project_scripts_forbidden",
        "package.json.scripts",
        "Template projects cannot declare package scripts or lifecycle hooks.",
      ),
    );
  }
  if (
    record?.license !== undefined &&
    (typeof record.license !== "string" || record.license.trim().length === 0)
  ) {
    diagnostics.push(
      diagnostic(
        "project_license_invalid",
        "package.json.license",
        "Template project license metadata must be a non-empty string.",
      ),
    );
  }
  if (diagnostics.length > 0) {
    return { ok: false, root, diagnostics };
  }

  const template = await readTemplateManifestFile(root);
  if (!template.ok) {
    return { ok: false, root, diagnostics: template.diagnostics };
  }
  const excludedSource = [
    ...(template.snapshot.openClawProfile
      ? [
          {
            path: template.snapshot.openClawProfile.sourcePath,
            diagnosticPath: "$.metadata.openclaw.config",
          },
        ]
      : []),
    ...template.snapshot.workspaceSources.map((source) => ({
      path: source.sourcePath,
      diagnosticPath: "$.workspace",
    })),
  ].find((source) => isExcludedProjectSource(source.path));
  if (excludedSource) {
    return failure(
      "project_excluded_source",
      excludedSource.diagnosticPath,
      `Selected project source ${JSON.stringify(excludedSource.path)} cannot come from .git or node_modules.`,
    );
  }
  const reservedPackageSource = template.snapshot.workspaceSources.find(
    (source) => source.sourcePath.normalize("NFC").toLowerCase() === "package.json",
  );
  if (reservedPackageSource) {
    return failure(
      "project_invalid",
      "$.workspace.files",
      `Workspace source ${JSON.stringify(reservedPackageSource.sourcePath)} collides with generated package metadata.`,
    );
  }
  let license: { byteLength: number; digest: string } | undefined;
  try {
    const licenseEntry = await lstat(resolve(root, "LICENSE")).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (licenseEntry) {
      const sourceRoot = await fsSafeRoot(root);
      const read = await sourceRoot.read("LICENSE", {
        hardlinks: "reject",
        maxBytes: MAX_MANAGED_FILE_BYTES,
        nonBlockingRead: true,
        symlinks: "reject",
      });
      license = {
        byteLength: read.buffer.byteLength,
        digest: `sha256:${createHash("sha256").update(read.buffer).digest("hex")}`,
      };
    }
  } catch (error) {
    return failure(
      "project_license_invalid",
      "LICENSE",
      `Package-root LICENSE must be a safe regular file: ${coerceErrorMessage(error)}`,
    );
  }
  const selectedPathList = [
    "package.json",
    "CLAW.md",
    ...(license ? ["LICENSE"] : []),
    ...(template.packageBootstrap ? ["BOOTSTRAP.md"] : []),
    ...(template.snapshot.openClawProfile ? [template.snapshot.openClawProfile.sourcePath] : []),
    ...template.snapshot.workspaceSources.map((source) => source.sourcePath),
  ];
  const portableSelectedPaths = new Map<string, string>();
  for (const path of selectedPathList) {
    const key = portableTemplatePathKey(path);
    const existing = portableSelectedPaths.get(key);
    if (existing && existing !== path) {
      return failure(
        "project_path_collision",
        "$",
        `Selected project paths ${JSON.stringify(existing)} and ${JSON.stringify(path)} collide on portable filesystems.`,
      );
    }
    portableSelectedPaths.set(key, path);
  }
  const selectedPaths = new Set(selectedPathList);
  let excludedPaths: string[];
  try {
    const excluded: string[] = [];
    const [canonical, folded] = await Promise.all([
      lstat(resolve(root, "CLAW.md")).catch(() => undefined),
      lstat(resolve(root, "claw.md")).catch(() => undefined),
    ]);
    const caseInsensitive = Boolean(
      canonical && folded && canonical.dev === folded.dev && canonical.ino === folded.ino,
    );
    const selectedPathKeys = new Set(
      [...selectedPaths].map((path) => projectPathKey(path, caseInsensitive)),
    );
    let entryCount = 0;
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(resolve(root, directory), { withFileTypes: true });
      for (const entry of entries) {
        entryCount += 1;
        if (entryCount > MAX_PROJECT_ENTRIES) {
          throw new TemplateProjectError(
            "project_too_many_entries",
            `Template projects may contain at most ${MAX_PROJECT_ENTRIES} entries outside excluded dependency and source-control trees.`,
          );
        }
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name === ".git" || entry.name === "node_modules") {
            excluded.push(`${path}/`);
          } else {
            await visit(path);
          }
        } else if (!selectedPathKeys.has(projectPathKey(path, caseInsensitive))) {
          excluded.push(path);
        }
      }
    };
    await visit("");
    excludedPaths = excluded.toSorted((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
  } catch (error) {
    return failure(
      error instanceof TemplateProjectError ? error.code : "project_enumeration_failed",
      "$",
      coerceErrorMessage(error),
    );
  }
  return {
    ok: true,
    root,
    packageJson: {
      name: template.source.name,
      version: template.source.version,
      ...(typeof record?.type === "string" ? { type: record.type } : {}),
      ...(typeof record?.license === "string" ? { license: record.license } : {}),
      openclaw: { template: "CLAW.md" },
    },
    template,
    license,
    excludedPaths,
    diagnostics: template.diagnostics,
  };
}
