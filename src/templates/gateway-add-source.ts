import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import {
  MAX_TEMPLATE_UPLOAD_ARCHIVE_BYTES,
  MAX_TEMPLATE_UPLOAD_BASE64_LENGTH,
  MAX_TEMPLATE_UPLOAD_EXTRACTED_BYTES,
  MAX_TEMPLATE_UPLOAD_ENTRIES,
} from "../../packages/gateway-protocol/src/template-source-limits.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  ClawHubSourceError,
  persistExtractedSource,
  readVerifiedArtifactSource,
} from "./clawhub-source-artifact.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import { buildTemplateProject, extractBuiltTemplateArtifact } from "./project-build.js";
import { validateTemplateProject } from "./project.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";

export type TemplateAddSource =
  | ClawHubCoordinate
  | { kind: "local"; path: string }
  | { kind: "upload"; archiveBase64: string };
export type TemplateAddDiagnosticStage =
  | "source_resolution_and_plan"
  | "upload_decode_and_staging"
  | "upload_extraction"
  | "upload_validation"
  | "plan"
  | "apply";
export type TemplateAddStageHook = (stage: TemplateAddDiagnosticStage) => void;

type SourceTrust = { trustWarning?: string; riskAcknowledgementRequired: boolean };
type Source = Awaited<ReturnType<typeof readVerifiedArtifactSource>>;

/** Local paths are interpreted on the Gateway host, after operator-admin admission. */
export async function withResolvedTemplateAddSource<T>(
  params: Omit<Parameters<typeof withResolvedClawHubSource<T>>[0], "coordinate" | "run"> & {
    coordinate: TemplateAddSource;
    onStage?: TemplateAddStageHook;
    run: (source: Source, trust: SourceTrust, persist: () => Promise<Source>) => Promise<T>;
  },
): Promise<{ value: T }> {
  if (!("kind" in params.coordinate)) {
    return await withResolvedClawHubSource({ ...params, coordinate: params.coordinate });
  }
  if (params.coordinate.kind === "upload") {
    params.onStage?.("upload_decode_and_staging");
    const encoded = params.coordinate.archiveBase64;
    const invalidUpload = () =>
      new ClawHubSourceError(
        "template_upload_invalid",
        "Could not read the Template archive. Upload a valid .tgz Template project (at most 1 MiB), without links or unsafe paths, and retry.",
      );
    if (
      encoded.length > MAX_TEMPLATE_UPLOAD_BASE64_LENGTH ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    ) {
      throw invalidUpload();
    }
    const bytes = Buffer.from(encoded, "base64");
    if (
      !bytes.length ||
      bytes.length > MAX_TEMPLATE_UPLOAD_ARCHIVE_BYTES ||
      bytes.toString("base64") !== encoded
    ) {
      throw invalidUpload();
    }
    await using staging = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-template-upload-",
    });
    const archivePath = staging.path("template.tgz");
    await writeFile(archivePath, bytes, { mode: 0o600 });
    const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    params.onStage?.("upload_extraction");
    const resolved = await withExtractedArchiveRoot({
      archivePath,
      tempDirPrefix: "openclaw-template-upload-extract-",
      timeoutMs: 30_000,
      rootMarkers: ["package.json", "CLAW.md"],
      limits: {
        maxArchiveBytes: MAX_TEMPLATE_UPLOAD_ARCHIVE_BYTES,
        maxExtractedBytes: MAX_TEMPLATE_UPLOAD_EXTRACTED_BYTES,
        maxEntryBytes: MAX_MANAGED_FILE_BYTES,
        maxEntries: MAX_TEMPLATE_UPLOAD_ENTRIES,
      },
      onExtracted: async (rootDir) => {
        params.onStage?.("upload_validation");
        const project = await validateTemplateProject(rootDir).catch(() => {
          throw invalidUpload();
        });
        if (!project.ok) {
          throw invalidUpload();
        }
        const identity = {
          packageName: project.packageJson.name,
          version: project.packageJson.version,
          artifactSha256,
          artifactByteLength: bytes.length,
        };
        const source = await readVerifiedArtifactSource({ sourceRoot: rootDir, ...identity }).catch(
          () => {
            throw invalidUpload();
          },
        );
        const persist = async () => {
          if (params.mode !== "apply") {
            throw new Error("A Template preview cannot persist package content.");
          }
          const sourceRoot = await persistExtractedSource({
            rootDir,
            archivePath,
            artifactSha256,
            artifactByteLength: bytes.length,
            stateDir: params.stateDir,
          });
          return await readVerifiedArtifactSource({ sourceRoot, ...identity });
        };
        return {
          ok: true as const,
          value: await params.run(
            source,
            {
              trustWarning:
                "Uploaded Template project: not published to or scanned by ClawHub. Review the project before installing.",
              riskAcknowledgementRequired: false,
            },
            persist,
          ),
        };
      },
    });
    if (!resolved.ok) {
      throw invalidUpload();
    }
    return { value: resolved.value };
  }
  if (!path.isAbsolute(params.coordinate.path)) {
    throw new Error("Local Template project paths must be absolute paths on the Gateway host.");
  }
  await using staging = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-template-local-",
  });
  const built = await buildTemplateProject(params.coordinate.path, staging.path("template.tgz"));
  await using extracted = await extractBuiltTemplateArtifact(built.artifact);
  const identity = {
    packageName: built.template.name,
    version: built.template.version,
    artifactSha256: built.integrity.replace(/^sha256:/, ""),
    artifactByteLength: built.byteLength,
  };
  const source = await readVerifiedArtifactSource({
    sourceRoot: extracted.packageRoot,
    ...identity,
  });
  const trust: SourceTrust = {
    trustWarning:
      "Local Template project: not published to or scanned by ClawHub. Review the project before installing.",
    riskAcknowledgementRequired: false,
  };
  const persist = async () => {
    if (params.mode !== "apply") {
      throw new Error("A Template preview cannot persist package content.");
    }
    const sourceRoot = await persistExtractedSource({
      rootDir: extracted.packageRoot,
      archivePath: built.artifact,
      artifactSha256: identity.artifactSha256,
      artifactByteLength: built.byteLength,
      stateDir: params.stateDir,
    });
    return await readVerifiedArtifactSource({ sourceRoot, ...identity });
  };
  return { value: await params.run(source, trust, persist) };
}
