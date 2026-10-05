import path from "node:path";
import { z } from "zod";
import { buildGatewayInstallEntrypointCandidates } from "../../daemon/gateway-entrypoint.js";
import { OPENCLAW_WRAPPER_ENV_KEY } from "../../daemon/program-args.js";
import { resolvePinnedDaemonRuntimePath } from "../../daemon/runtime-paths.js";
import { isUpdateOwnedGatewayServiceCommand } from "../../daemon/service-update-authority.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { isRegularFile } from "../../infra/executable-path.js";
import { resolveStableNodePath } from "../../infra/stable-node-path.js";
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
import type { DaemonInstallOptions } from "./types.js";

const serviceFile = z
  .string()
  .refine((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file) && isRegularFile(file));
const restoreServiceCliSchema = z.strictObject({
  executable: z.string(),
  entrypoint: serviceFile.refine(
    (entry) =>
      path.basename(entry) === "openclaw.mjs" ||
      buildGatewayInstallEntrypointCandidates(path.dirname(path.dirname(entry))).includes(
        path.normalize(entry),
      ),
  ),
  sqliteLibrary: serviceFile.nullable(),
});

/** Validate recovery before config preparation; SQLite selection changes only the service env. */
export async function resolveRestoreServiceCli(
  raw: string,
  opts: DaemonInstallOptions,
  installEnv: NodeJS.ProcessEnv,
) {
  const serviceCli = safeParseJsonWithSchema(restoreServiceCliSchema, raw);
  if (!serviceCli) {
    throw new Error("Invalid restore service CLI.");
  }
  const { runtime, runtimePath: pin, wrapper, expectedRuntimePin } = opts;
  const { executable, sqliteLibrary } = serviceCli;
  try {
    if (expectedRuntimePin === undefined) {
      throw new Error("requires --expected-runtime-pin.");
    }
    if (runtime !== "node" && runtime !== "bun") {
      throw new Error('requires an explicit --runtime ("node" or "bun").');
    }
    if (wrapper !== undefined || installEnv[OPENCLAW_WRAPPER_ENV_KEY]?.trim()) {
      throw new Error("cannot be combined with a wrapper.");
    }
    if (pin !== undefined && path.normalize(pin) !== path.normalize(executable)) {
      throw new Error("executable must match --runtime-path.");
    }
    if (
      isUpdateOwnedGatewayServiceCommand() ||
      isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS)
    ) {
      throw new Error("cannot be combined with update-owned reconciliation.");
    }
    if (sqliteLibrary === null) {
      delete installEnv.OPENCLAW_SQLITE_LIBRARY;
    } else {
      installEnv.OPENCLAW_SQLITE_LIBRARY = sqliteLibrary;
    }
    let runtimePath = await resolvePinnedDaemonRuntimePath(executable, runtime, installEnv);
    if (runtime === "node" && pin === undefined && runtimePath) {
      runtimePath = await resolveStableNodePath(runtimePath);
    }
    return { serviceCli, runtimePath };
  } catch (error) {
    throw new Error(
      `--restore-service-cli ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
