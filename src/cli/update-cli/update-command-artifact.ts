import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { valid as validSemver } from "semver";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "../../config/gateway-env-selection.js";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import { tempWorkspace } from "../../infra/private-temp-workspace.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { compareSemverStrings } from "../../infra/update-check.js";
import { parseOpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { createUpdateProgress } from "./progress.js";
import type { InitializedUpdate } from "./update-command-initialization.js";
import { withUpdateInitializationCleanup } from "./update-command-initialization.js";
import { stagePackageInstallUpdate } from "./update-command-package.js";

type StageParams = Parameters<typeof stagePackageInstallUpdate>[0];
type ArtifactInitialization = Pick<InitializedUpdate, "stagedPackage"> & {
  target: Pick<
    InitializedUpdate["target"],
    | "currentVersion"
    | "targetVersion"
    | "packageTargetSchemaVersions"
    | "packageRuntimeTarget"
    | "downgradeRisk"
    | "packageAlreadyCurrent"
    | "refuseUpdate"
  >;
};

/** Candidate hooks may initialize their own profile, never the profile awaiting admission. */
async function withFreshUpdateArtifact<T>(
  params: StageParams,
  use: (candidate: {
    stage: Awaited<ReturnType<typeof stagePackageInstallUpdate>>;
    manifest: unknown;
  }) => Promise<T>,
): Promise<T> {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-update-artifact-",
  });
  return await withUpdateInitializationCleanup(
    async () => {
      const home = workspace.dir;
      const state = path.join(home, "state");
      const tmp = path.join(home, "tmp");
      await fs.mkdir(tmp);
      const env = { ...params.installEnv };
      // Child env overlays process.env. Tombstones must survive until spawn.
      for (const key of [
        ...[...GATEWAY_CONFIG_SELECTION_ENV_KEYS].filter(
          (selector) => selector.startsWith("OPENCLAW_") || selector === "PI_CODING_AGENT_DIR",
        ),
        ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
        ...SUPERVISOR_HINT_ENV_VARS,
        "STATE_DIRECTORY",
        "NODE_COMPILE_CACHE",
        "OPENCLAW_GATEWAY_SERVICE_PID",
        "OPENCLAW_SERVICE_MARKER",
        "OPENCLAW_SERVICE_KIND",
        "OPENCLAW_UPDATE_RUN_ID",
        "OPENCLAW_UPDATE_RUN_HANDOFF",
        "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META",
        "OPENCLAW_UPDATE_POST_CORE",
        "OPENCLAW_UPDATE_POST_CORE_CHANNEL",
        "OPENCLAW_UPDATE_POST_CORE_RESULT_PATH",
        "OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH",
        "OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS",
        "OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL",
        "OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH",
        "OPENCLAW_DIAGNOSTICS_TIMELINE_PATH",
      ]) {
        env[key] = undefined;
      }
      Object.assign(env, {
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        NODE_DISABLE_COMPILE_CACHE: "1",
      });
      const stage = await stagePackageInstallUpdate({ ...params, installEnv: env });
      return await withUpdateInitializationCleanup(
        async () => {
          const manifest: unknown = JSON.parse(
            await fs.readFile(path.join(stage.root, "package.json"), "utf8"),
          );
          return await use({ stage, manifest });
        },
        () => stage.close(),
      );
    },
    async () => {
      await workspace.cleanup();
    },
  );
}

/** Explicit artifacts need their own declaration; a familiar version is not provenance. */
function readFreshUpdateArtifactMetadata(manifest: unknown) {
  if (
    !isRecord(manifest) ||
    typeof manifest.version !== "string" ||
    !validSemver(manifest.version)
  ) {
    return undefined;
  }
  const schemas = isRecord(manifest.openclaw)
    ? parseOpenClawSchemaVersions(manifest.openclaw.schemaVersions)
    : undefined;
  if (!schemas) {
    return undefined;
  }
  return {
    version: manifest.version,
    schemaVersions: schemas,
    nodeEngine:
      isRecord(manifest.engines) && typeof manifest.engines.node === "string"
        ? manifest.engines.node
        : null,
  };
}

/** Bind the inspected artifact to the existing fresh-profile admission flow. */
export async function runFreshUpdateArtifact(
  params: {
    initialization: ArtifactInitialization;
    stageParams: (progress: ReturnType<typeof createUpdateProgress>["progress"]) => StageParams;
    json: boolean;
  },
  run: () => Promise<void>,
): Promise<void> {
  const presentation = createUpdateProgress(!params.json);
  const { initialization } = params;
  const { target } = initialization;
  try {
    return await withFreshUpdateArtifact(
      params.stageParams(presentation.progress),
      async ({ stage, manifest }) => {
        initialization.stagedPackage = stage;
        const metadata = readFreshUpdateArtifactMetadata(manifest);
        if (!metadata) {
          return await target.refuseUpdate(
            "target-metadata-preflight",
            "The selected artifact does not declare its database schema support. Use a compatible artifact with schema metadata, or an exact published --tag.",
          );
        }
        const comparison = compareSemverStrings(target.currentVersion, metadata.version);
        target.downgradeRisk = comparison !== null && comparison > 0;
        target.packageAlreadyCurrent = false;
        target.targetVersion = metadata.version;
        target.packageTargetSchemaVersions = metadata.schemaVersions;
        target.packageRuntimeTarget = {
          version: metadata.version,
          nodeEngine: metadata.nodeEngine,
        };
        return await run();
      },
    );
  } finally {
    presentation.dispose();
  }
}
