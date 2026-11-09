import path from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { persistExtractedSource, readVerifiedArtifactSource } from "./clawhub-source-artifact.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import { buildTemplateProject, extractBuiltTemplateArtifact } from "./project-build.js";

export type TemplateAddSource = ClawHubCoordinate | { kind: "local"; path: string };
type SourceTrust = { trustWarning?: string; riskAcknowledgementRequired: boolean };
type Source = Awaited<ReturnType<typeof readVerifiedArtifactSource>>;

/** Local paths are interpreted on the Gateway host, after operator-admin admission. */
export async function withResolvedTemplateAddSource<T>(
  params: Omit<Parameters<typeof withResolvedClawHubSource<T>>[0], "coordinate" | "run"> & {
    coordinate: TemplateAddSource;
    run: (source: Source, trust: SourceTrust, persist: () => Promise<Source>) => Promise<T>;
  },
): Promise<{ value: T }> {
  if (!("kind" in params.coordinate)) {
    return await withResolvedClawHubSource({ ...params, coordinate: params.coordinate });
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
