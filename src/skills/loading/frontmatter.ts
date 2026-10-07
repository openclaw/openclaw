import {
  normalizeOptionalString,
  readNonEmptyStringPreservingWhitespace,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeCsvOrLooseStringList } from "@openclaw/normalization-core/string-normalization";
import { parseFrontmatterBlockResult } from "../../../packages/markdown-core/src/frontmatter.js";
import { validateRegistryNpmSpec } from "../../infra/npm-registry-spec.js";
import {
  applyOpenClawManifestInstallCommonFields,
  getFrontmatterString,
  parseOpenClawManifestInstallBase,
  parseFrontmatterBool,
  resolveOpenClawManifestBlock,
  resolveOpenClawManifestInstall,
  resolveOpenClawManifestOs,
  resolveOpenClawManifestRequires,
} from "../../shared/frontmatter.js";
import type {
  OpenClawSkillMetadata,
  ParsedSkillFrontmatter,
  SkillEntry,
  SkillInstallSpec,
  SkillInvocationPolicy,
} from "../types.js";

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const parsed = parseFrontmatterBlockResult(content);
  const issue = parsed.issues[0];
  if (issue) {
    throw new Error(`invalid frontmatter: ${issue.code}: ${issue.message}`);
  }
  // Cached metadata must not retain the discarded SKILL.md through parser slices.
  // The normalized record contains only strings; copy its keys and values together.
  return structuredClone(parsed.frontmatter);
}

const BREW_FORMULA_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@+._/-]*$/;
const GO_MODULE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~+\-/]*(?:@[A-Za-z0-9][A-Za-z0-9._~+\-/]*)?$/;
const UV_PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-[\]=<>!~+,]*$/;

function normalizeSafeBrewFormula(raw: unknown): string | undefined {
  const formula = normalizeOptionalString(raw);
  return formula && BREW_FORMULA_PATTERN.test(formula) && !formula.includes("..")
    ? formula
    : undefined;
}

function normalizeSafeNpmSpec(raw: unknown): string | undefined {
  const spec = normalizeOptionalString(raw);
  if (!spec || spec.startsWith("-")) {
    return undefined;
  }
  if (validateRegistryNpmSpec(spec) !== null) {
    return undefined;
  }
  return spec;
}

function normalizeSafePackageSpec(raw: unknown, pattern: RegExp): string | undefined {
  const value = normalizeOptionalString(raw);
  return value && pattern.test(value) ? value : undefined;
}

function normalizeSafeDownloadUrl(raw: unknown): string | undefined {
  const value = normalizeOptionalString(raw);
  if (!value || /\s/.test(value)) {
    return undefined;
  }
  const parsed = URL.parse(value);
  return parsed?.protocol === "http:" || parsed?.protocol === "https:"
    ? parsed.toString()
    : undefined;
}

function parseInstallSpec(input: unknown): SkillInstallSpec | undefined {
  const parsed = parseOpenClawManifestInstallBase(input, ["brew", "node", "go", "uv", "download"]);
  if (!parsed) {
    return undefined;
  }
  const { raw } = parsed;
  const spec = applyOpenClawManifestInstallCommonFields<SkillInstallSpec>(
    {
      kind: parsed.kind as SkillInstallSpec["kind"],
    },
    parsed,
  );
  const osList = normalizeCsvOrLooseStringList(raw.os);
  if (osList.length > 0) {
    spec.os = osList;
  }
  const formula = normalizeSafeBrewFormula(raw.formula) ?? normalizeSafeBrewFormula(raw.cask);
  if (formula) {
    spec.formula = formula;
  }
  if (spec.kind === "node" || spec.kind === "uv") {
    const pkg =
      spec.kind === "node"
        ? normalizeSafeNpmSpec(raw.package)
        : normalizeSafePackageSpec(raw.package, UV_PACKAGE_PATTERN);
    if (pkg) {
      spec.package = pkg;
    }
  }
  const moduleSpec = normalizeSafePackageSpec(raw.module, GO_MODULE_PATTERN);
  if (moduleSpec) {
    spec.module = moduleSpec;
  }
  const downloadUrl = normalizeSafeDownloadUrl(raw.url);
  if (downloadUrl) {
    spec.url = downloadUrl;
  }
  if (spec.kind === "download" && raw.sha256 !== undefined) {
    if (typeof raw.sha256 !== "string") {
      return undefined;
    }
    const sha256 = raw.sha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      return undefined;
    }
    spec.sha256 = sha256;
  }
  if (typeof raw.archive === "string") {
    spec.archive = raw.archive;
  }
  if (typeof raw.extract === "boolean") {
    spec.extract = raw.extract;
  }
  if (typeof raw.stripComponents === "number") {
    spec.stripComponents = raw.stripComponents;
  }
  if (typeof raw.targetDir === "string") {
    spec.targetDir = raw.targetDir;
  }

  const target = {
    brew: spec.formula,
    node: spec.package,
    go: spec.module,
    uv: spec.package,
    download: spec.url,
  }[spec.kind];
  return target ? spec : undefined;
}

export function resolveSkillManifestMetadata(
  frontmatter: ParsedSkillFrontmatter,
): OpenClawSkillMetadata | undefined {
  const metadataObj = resolveOpenClawManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const requires = resolveOpenClawManifestRequires(metadataObj);
  const install = resolveOpenClawManifestInstall(metadataObj, parseInstallSpec);
  const osRaw = resolveOpenClawManifestOs(metadataObj);
  return {
    always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
    emoji: readStringValue(metadataObj.emoji),
    homepage: readStringValue(metadataObj.homepage),
    skillKey: readNonEmptyStringPreservingWhitespace(metadataObj.skillKey),
    primaryEnv: readStringValue(metadataObj.primaryEnv),
    os: osRaw.length > 0 ? osRaw : undefined,
    requires,
    install: install.length > 0 ? install : undefined,
  };
}

export function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): SkillInvocationPolicy {
  return {
    userInvocable: parseFrontmatterBool(getFrontmatterString(frontmatter, "user-invocable"), true),
    disableModelInvocation: parseFrontmatterBool(
      getFrontmatterString(frontmatter, "disable-model-invocation"),
      false,
    ),
  };
}

export function resolveSkillKey(entry: SkillEntry): string {
  return entry.metadata?.skillKey ?? entry.skill.name;
}
