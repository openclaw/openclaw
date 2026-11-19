// A registry-published display projection is never an install plan or a verified source.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { assessClawHubTrust } from "../infra/clawhub-install-trust.js";
import { parseClawHubPackageSecurityResponse } from "../infra/clawhub-packages.js";
import type { ClawHubTemplateCatalogDetail } from "./clawhub-catalog-types.js";
import { parseTemplateManifestSummary } from "./clawhub-manifest-summary.js";
import { ClawHubSourceError, readExactTemplateArtifact } from "./clawhub-source-artifact.js";
import {
  isCanonicalClawHubPackageName,
  isExactSemVer,
  isSafeTemplateRelativePath,
} from "./schema-portability.js";

const label = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32),
  );
const relativePath = label.refine(isSafeTemplateRelativePath);
const nameAndVersion = {
  ref: label.refine(isCanonicalClawHubPackageName),
  version: label.refine(isExactSemVer),
};
const bundled = { name: label, source: z.literal("bundled"), path: relativePath };
const external = { name: label, source: z.literal("clawhub"), ...nameAndVersion };
const Contents = z.strictObject({
  instructions: z.array(z.strictObject({ name: relativePath, source: relativePath })).max(4096),
  skills: z.array(z.union([z.strictObject(bundled), z.strictObject(external)])).max(1024),
  integrations: z
    .array(
      z.union([
        z.strictObject({ ...bundled, kind: z.literal("plugin") }),
        z.strictObject({ ...external, kind: z.literal("plugin") }),
        z.strictObject({ name: label, kind: z.literal("mcpServer") }),
      ]),
    )
    .max(1024),
  automations: z
    .array(z.strictObject({ name: label, enabled: z.boolean(), schedule: label, timezone: label }))
    .max(1024),
});
const Inventory = z.object({
  schemaVersion: z.literal(1),
  packageName: label,
  version: label.refine(isExactSemVer),
  manifestPath: relativePath,
  artifact: z.looseObject({
    kind: z.literal("npm-pack"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    npmIntegrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u),
    npmShasum: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .nullish(),
  }),
  icon: z.string().max(2048).nullable(),
  templateManifestSummary: z.unknown(),
  contents: Contents,
  security: z.unknown(),
});
function invalid(): never {
  throw new ClawHubSourceError(
    "clawhub_invalid_inventory",
    "ClawHub returned an invalid or incomplete Template display inventory.",
  );
}
export function readTemplateDisplayInventory(
  input: unknown,
  coordinate: { packageName: string; version: string },
  latestArtifactClaims: ReadonlyArray<unknown> = [],
) {
  const parsed = Inventory.safeParse(input);
  if (!parsed.success) {
    return invalid();
  }
  const { packageName, version, artifact, contents, icon } = parsed.data;
  // The exact artifact reader rejects contradictory aliases (legacy digest/kind, source and coordinate).
  readExactTemplateArtifact(
    { package: { name: packageName, family: "template" }, version, artifact },
    coordinate,
  );
  for (const claim of latestArtifactClaims) {
    if (claim == null) {
      continue;
    }
    if (!isRecord(claim)) {
      return invalid();
    }
    for (const [key, expected] of Object.entries({
      sha256: artifact.sha256,
      artifactSha256: artifact.sha256,
      npmIntegrity: artifact.npmIntegrity,
      npmShasum: artifact.npmShasum,
      kind: "npm-pack",
      artifactKind: "npm-pack",
      packageName,
      version,
      source: "clawhub",
    })) {
      if (claim[key] != null && claim[key] !== expected) {
        return invalid();
      }
    }
    if (claim.available === false) {
      return invalid();
    }
  }
  const security = parseClawHubPackageSecurityResponse(parsed.data.security);
  const auditUrl = URL.parse(security.securityAuditUrl);
  if (
    !auditUrl ||
    !["http:", "https:"].includes(auditUrl.protocol) ||
    auditUrl.username ||
    auditUrl.password
  ) {
    return invalid();
  }
  if (
    packageName !== coordinate.packageName ||
    version !== coordinate.version ||
    security.package?.name !== packageName ||
    security.package.family !== "template" ||
    security.release?.version !== version ||
    security.release.artifactKind !== "npm-pack" ||
    security.release.artifactSha256 !== artifact.sha256 ||
    security.release.npmIntegrity !== artifact.npmIntegrity ||
    (security.release.npmShasum ?? null) !== (artifact.npmShasum ?? null)
  ) {
    return invalid();
  }
  if (assessClawHubTrust(security) === "blocked") {
    throw new ClawHubSourceError(
      "clawhub_download_blocked",
      "ClawHub withheld the Template inventory for this release.",
    );
  }
  const summary = parseTemplateManifestSummary(parsed.data.templateManifestSummary);
  const counts = countTemplateContents(contents);
  const files = new Set(contents.instructions.map((f) => f.name));
  const bootstrap = new Set(summary.bootstrapFiles);
  // Older summaries may omit native first-run seeds. A seed row must never stand in
  // for a missing managed file. A real managed SOUL.md is not the generated body.
  const managed = contents.instructions.filter(
    ({ name, source }) =>
      !bootstrap.has(name) &&
      name !== "BOOTSTRAP.md" &&
      !(name === "SOUL.md" && source === "CLAW.md#body"),
  );
  if (
    files.size !== contents.instructions.length ||
    bootstrap.size !== summary.bootstrapFiles.length ||
    !summary.bootstrapFiles.every((name) => files.has(name)) ||
    managed.length !== summary.fileCount ||
    counts.skills !== summary.skillCount ||
    counts.plugins !== summary.pluginCount ||
    counts.mcpServers !== summary.mcpServerCount ||
    counts.scheduledJobs !== summary.cronJobCount
  ) {
    return invalid();
  }
  return { contents, summary, security, icon: icon ?? undefined }; // The Control UI never opens manifestPath implicitly.
}
export function countTemplateContents(contents: ClawHubTemplateCatalogDetail["contents"]) {
  return {
    workspaceFiles: contents.instructions.length,
    skills: contents.skills.length,
    plugins: contents.integrations.filter((i) => i.kind === "plugin").length,
    mcpServers: contents.integrations.filter((i) => i.kind === "mcpServer").length,
    scheduledJobs: contents.automations.length,
  };
}
