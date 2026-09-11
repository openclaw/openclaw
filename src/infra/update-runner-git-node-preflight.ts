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
  // Bun exposes an emulated process.versions.node, which is not proof that Node can run the target.
  if (process.versions.bun) {
    return null;
  }
  const engine = await readCandidateNodeEngine(root);
  const currentVersion = process.versions.node;
  const capabilityError = nodeRuntimeFailure(currentVersion, detectCurrentSqliteCapabilities());
  if (!capabilityError && nodeVersionSatisfiesEngine(currentVersion, engine) !== false) {
    return null;
  }

  const systemNode = await resolveSystemNodeInfo({
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
    stdoutTail: `Node ${currentVersion} (${process.execPath}); requires engines.node ${engine}`,
    stderrTail: `${capabilityError ? `${capabilityError}\n` : ""}Activate a compatible Node for the CLI, then retry. ${systemDiagnostic}`,
  };
}
