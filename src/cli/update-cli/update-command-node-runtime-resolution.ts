import path from "node:path";
import { pathToFileURL } from "node:url";
import type { NodeRuntimeInstallCommand } from "../../../node-runtime-recovery.mjs";
import { parseNodeReleaseVersion } from "../../../node-version.mjs";
import { readResponseWithLimit } from "../../infra/http-response-body.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";

export type PackageRuntimeRecovery = {
  env: NodeJS.ProcessEnv;
  installCommand?: NodeRuntimeInstallCommand;
};

/** Select the newest patch in the lowest compatible even-numbered Node release line. */
export async function resolveTargetNodeRuntime(params: {
  engine: string;
  recovery: PackageRuntimeRecovery;
  timeoutMs?: number;
}): Promise<string | undefined> {
  // The bootstrap module owns package-relative installer assets. Bundling it into
  // dist changes import.meta.url and points those assets at nonexistent dist/scripts.
  const driverRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (!driverRoot) {
    return undefined;
  }
  const { findUsableNodeRuntime }: typeof import("../../../node-runtime-recovery.mjs") =
    await import(pathToFileURL(path.join(driverRoot, "node-runtime-recovery.mjs")).href);
  const acceptVersion = (version: string) =>
    nodeVersionSatisfiesEngine(version, params.engine) === true;
  const options = { ...params.recovery, acceptVersion };
  const available = await findUsableNodeRuntime(options);
  if (available) {
    return available.nodePath;
  }
  if (!params.recovery.installCommand) {
    return undefined;
  }
  // Fixed upstream metadata selects an exact checksum-verified installer target.
  // An unavailable release is not permission to install a merely newer runtime.
  let nodeVersion: string | undefined;
  try {
    const signal = AbortSignal.timeout(Math.min(params.timeoutMs ?? 30_000, 30_000));
    const response = await fetch("https://nodejs.org/dist/index.json", {
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      void response.body?.cancel();
      return undefined;
    }
    const releases: unknown = JSON.parse(
      (await readResponseWithLimit(response, 2 * 1024 * 1024, { signal })).toString("utf8"),
    );
    if (!Array.isArray(releases)) {
      return undefined;
    }
    nodeVersion = releases
      .flatMap((release: { version?: unknown }) => {
        const version =
          typeof release?.version === "string" ? parseNodeReleaseVersion(release.version) : null;
        if (!version || version.major < 24 || version.major % 2 !== 0) {
          return [];
        }
        const label = `${version.major}.${version.minor}.${version.patch}`;
        return acceptVersion(label) ? [{ ...version, label }] : [];
      })
      .toSorted((a, b) => a.major - b.major || b.minor - a.minor || b.patch - a.patch)[0]?.label;
  } catch {
    return undefined;
  }
  if (!nodeVersion) {
    return undefined;
  }
  return (await findUsableNodeRuntime({ ...options, allowInstall: true, nodeVersion }))?.nodePath;
}
