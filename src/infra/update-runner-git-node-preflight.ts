import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { detectCurrentSqliteCapabilities, nodeRuntimeFailure } from "../../node-sqlite.mjs";
import { resolveNodeRuntimeInfo, resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import { tryReadJson } from "./json-files.js";
import { mergePathPrepend } from "./path-prepend.js";
import { resolveEnvironmentValue } from "./process-env.js";
import { nodeVersionSatisfiesEngine } from "./runtime-guard.js";
import type { UpdateStepResult } from "./update-step-result.js";

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

async function resolveCandidateNode(env: NodeJS.ProcessEnv, engine: string | null) {
  let firstAvailable: Awaited<ReturnType<typeof resolveSystemNodeInfo>> = null;
  const directories = (resolveEnvironmentValue(env, "PATH") ?? "")
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory));
  for (const directory of new Set(directories)) {
    const executable = resolveExecutableFromPathEnv("node", [directory], env, { useCache: false });
    if (!executable) {
      continue;
    }
    const runtime = { ...(await resolveNodeRuntimeInfo(executable, env)), path: executable };
    if (
      runtime.status === "supported" &&
      nodeVersionSatisfiesEngine(runtime.version, engine) !== false
    ) {
      return runtime;
    }
    firstAvailable ??= runtime;
  }
  const systemNode = await resolveSystemNodeInfo({
    env,
    acceptNodeVersion: (version) => nodeVersionSatisfiesEngine(version, engine) !== false,
  });
  return systemNode?.status === "supported" &&
    nodeVersionSatisfiesEngine(systemNode.version, engine) !== false
    ? systemNode
    : (firstAvailable ?? systemNode);
}

/** Qualify package-tooling Node and bind candidate commands without changing the Gateway runtime. */
export async function prepareGitCandidateNodeRuntime(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  mode: "package-tooling" | "current-runtime" = "package-tooling",
): Promise<{ env: NodeJS.ProcessEnv; step?: never } | { step: UpdateStepResult; env?: never }> {
  const startedAt = Date.now();
  const engine = await readCandidateNodeEngine(root);
  let currentVersion = process.versions.node;
  let currentPath = process.execPath;
  let capabilityError = process.versions.bun
    ? null
    : nodeRuntimeFailure(currentVersion, await detectCurrentSqliteCapabilities());
  let systemNode: Awaited<ReturnType<typeof resolveSystemNodeInfo>> | null = null;

  if (
    process.versions.bun ||
    (mode === "package-tooling" &&
      path.basename(currentPath) !== (process.platform === "win32" ? "node.exe" : "node") &&
      !capabilityError &&
      nodeVersionSatisfiesEngine(currentVersion, engine) !== false)
  ) {
    // Tooling follows the updater's PATH, which can contain an operator-managed
    // Node outside daemon installation paths. Bun's emulated Node version is not proof.
    systemNode = await resolveCandidateNode(env, engine);
    currentPath = systemNode?.path ?? "system Node";
    currentVersion =
      systemNode?.status === "supported" || systemNode?.status === "unsupported"
        ? (systemNode.version ?? "unknown")
        : "unavailable";
    capabilityError =
      systemNode === null
        ? "No Node executable was found."
        : systemNode.status === "probe-failed"
          ? systemNode.error.message
          : systemNode.status === "unsupported"
            ? (systemNode.capabilityError ??
              nodeRuntimeFailure(systemNode.version, systemNode.sqliteProbe) ??
              "Node requires WAL-reset-safe SQLite.")
            : null;
  }
  if (!capabilityError && nodeVersionSatisfiesEngine(currentVersion, engine) !== false) {
    const pathKey =
      Object.keys(env)
        .toSorted()
        .find((key) =>
          process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH",
        ) ?? "PATH";
    return {
      env: {
        ...env,
        [pathKey]: mergePathPrepend(resolveEnvironmentValue(env, "PATH"), [
          path.dirname(currentPath),
        ]),
      },
    };
  }

  systemNode ??= await resolveSystemNodeInfo({
    env,
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
    step: {
      name: "preflight-node-runtime",
      command: `check Node ${currentVersion} against engines.node ${engine}`,
      cwd: root,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: `Node ${currentVersion} (${currentPath}); requires engines.node ${engine}`,
      stderrTail: `${capabilityError ? `${capabilityError}\n` : ""}Activate a compatible Node for the CLI, then retry. ${systemDiagnostic}`,
    },
  };
}
