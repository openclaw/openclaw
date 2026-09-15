import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { detectCurrentSqliteCapabilities, nodeRuntimeFailure } from "../../node-sqlite.mjs";
import { resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import { tryReadJson } from "./json-files.js";
import { nodeVersionSatisfiesEngine } from "./runtime-guard.js";
import type { UpdateStepResult } from "./update-runner-types.js";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

async function readCandidateNodeEngine(root: string): Promise<string | null> {
  const manifest = asNullableRecord(
    await tryReadJson<unknown>(path.join(root, "package.json"), {
      maxBytes: MAX_PACKAGE_JSON_BYTES,
    }),
  );
  const engines = asNullableRecord(manifest?.engines);
  return normalizeNullableString(engines?.node);
}

/** Reports a proven candidate Node mismatch without changing the active runtime. */
export async function checkGitCandidateNodeRuntime(
  root: string,
  shortSha: string,
): Promise<UpdateStepResult | null> {
  const startedAt = Date.now();
  const engine = await readCandidateNodeEngine(root);
  let currentVersion = process.versions.node;
  let currentPath = process.execPath;
  let capabilityError: string | null;
  let systemNode: Awaited<ReturnType<typeof resolveSystemNodeInfo>> | null = null;

  if (process.versions.bun) {
    // Candidate package tooling runs under the installed system Node. Bun's
    // emulated process.versions.node does not prove that runtime can load it.
    systemNode = await resolveSystemNodeInfo({
      acceptNodeVersion: (version) => nodeVersionSatisfiesEngine(version, engine) !== false,
    });
    currentPath = systemNode?.path ?? "system Node";
    currentVersion =
      systemNode?.status === "supported" || systemNode?.status === "unsupported"
        ? (systemNode.version ?? "unknown")
        : "unavailable";
    capabilityError =
      systemNode === null
        ? "No system Node was found."
        : systemNode.status === "probe-failed"
          ? systemNode.error.message
          : systemNode.status === "unsupported"
            ? nodeRuntimeFailure(systemNode.version, systemNode.sqliteProbe)
            : null;
  } else {
    capabilityError = nodeRuntimeFailure(currentVersion, await detectCurrentSqliteCapabilities());
  }
  if (!capabilityError && nodeVersionSatisfiesEngine(currentVersion, engine) !== false) {
    return null;
  }

  systemNode ??= await resolveSystemNodeInfo({
    acceptNodeVersion: (version) => nodeVersionSatisfiesEngine(version, engine) !== false,
  });
  let systemDiagnostic: string;
  if (systemNode?.status === "probe-failed") {
    systemDiagnostic = `System Node compatibility remains unknown because its probe failed: ${systemNode.error.message}`;
  } else if (
    systemNode?.status === "supported" &&
    nodeVersionSatisfiesEngine(systemNode.version, engine) !== false
  ) {
    systemDiagnostic =
      "OpenClaw did not select or activate another runtime. " +
      `Existing compatible Node ${systemNode.version}: ${systemNode.path}`;
  } else {
    systemDiagnostic = "No compatible existing system Node was found.";
  }

  return {
    name: `preflight node runtime (${shortSha})`,
    command: `check Node ${currentVersion} against engines.node ${engine}`,
    cwd: root,
    durationMs: Date.now() - startedAt,
    exitCode: 1,
    stdoutTail: `Node ${currentVersion} (${currentPath}); requires engines.node ${engine}`,
    stderrTail: `${capabilityError ? `${capabilityError}\n` : ""}Activate a compatible Node for the CLI, then retry. ${systemDiagnostic}`,
  };
}
