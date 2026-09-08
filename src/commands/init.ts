/**
 * `openclaw init` — opt-in teammate install profile.
 *
 * `openclaw init --mode teammate` creates one persistent worker computer and
 * pins exec/browser/computer off the gateway host. It does not require
 * Cursor/xAI login (BYO models).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { formatCliJsonFailure } from "../cli/failure-output.js";
import { createConfigIO } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { resolveStateDir } from "../config/paths.js";
import { shortenHomePath } from "../utils.js";
import { renderTeammateComposeOverlay } from "../teammate/compose.js";
import { resolveTeammateExecPlacement } from "../teammate/exec-bind.js";
import {
  applyTeammateProfile,
  DEFAULT_TEAMMATE_BACKEND,
  isTeammateBackend,
  resolveTeammatePaths,
  TEAMMATE_SLA,
  type TeammateBackend,
} from "../teammate/profile.js";
import { renderTeammateReadme } from "../teammate/readme.js";
import { setupCommand } from "./setup.js";

type InitCommandDeps = {
  setup?: typeof setupCommand;
};

export type InitCommandOptions = {
  mode?: string;
  backend?: string;
  workspace?: string;
  json?: boolean;
};

function rejectInit(opts: InitCommandOptions, runtime: RuntimeEnv, message: string): void {
  if (opts.json) {
    writeRuntimeJson(runtime, formatCliJsonFailure(message));
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
}

export function resolveInitBackend(raw: string | undefined): TeammateBackend | null {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_TEAMMATE_BACKEND;
  }
  const normalized = raw.trim().toLowerCase();
  return isTeammateBackend(normalized) ? normalized : null;
}

/** Applies the teammate worker profile and writes README + compose overlay. */
export async function initCommand(
  opts: InitCommandOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
  deps: InitCommandDeps = {},
): Promise<void> {
  if (opts.mode !== "teammate") {
    rejectInit(
      opts,
      runtime,
      `Invalid --mode "${opts.mode ?? ""}". Use ${formatCliCommand("openclaw init --mode teammate")}.`,
    );
    return;
  }
  const backend = resolveInitBackend(opts.backend);
  if (!backend) {
    rejectInit(
      opts,
      runtime,
      `Invalid --backend "${String(opts.backend)}". Use docker, openshell, or firecracker.`,
    );
    return;
  }

  await (deps.setup ?? setupCommand)({ workspace: opts.workspace, json: false }, runtime);

  const io = createConfigIO();
  const prepared = await io.readConfigFileSnapshotForWrite();
  if (!prepared.snapshot.valid) {
    rejectInit(
      opts,
      runtime,
      `OpenClaw config is invalid at ${prepared.snapshot.path}. Run ${formatCliCommand("openclaw doctor")}.`,
    );
    return;
  }
  const baseConfig = (
    prepared.snapshot.exists ? prepared.snapshot.sourceConfig : {}
  ) as OpenClawConfig;
  const paths = resolveTeammatePaths();
  const next = applyTeammateProfile(baseConfig, { backend, homeDir: paths.homeDir });
  const { replaceConfigFile } = await import("../config/config.js");
  await replaceConfigFile({
    nextConfig: next,
    snapshot: prepared.snapshot,
    afterWrite: { mode: "auto" },
    writeOptions: prepared.writeOptions,
  });

  await fs.mkdir(paths.browserDir, { recursive: true });
  const teammateDir = path.join(resolveStateDir(), "teammate");
  await fs.mkdir(teammateDir, { recursive: true });
  const readmePath = path.join(teammateDir, "README.md");
  const composePath = path.join(teammateDir, "docker-compose.teammate.yml");
  const workerReadmePath = path.join(paths.homeDir, "README.md");
  const readme = renderTeammateReadme({ backend, paths });
  await fs.writeFile(readmePath, readme, "utf8");
  await fs.writeFile(workerReadmePath, readme, "utf8");
  await fs.writeFile(composePath, renderTeammateComposeOverlay({ backend, homeDir: paths.homeDir }), "utf8");

  const placement = resolveTeammateExecPlacement(next);
  const result = {
    ok: true,
    mode: "teammate" as const,
    backend,
    sla: TEAMMATE_SLA,
    execHost: placement.effectiveHost,
    gatewayExec: placement.gatewayExec,
    sandboxBackend: placement.sandboxBackend,
    homeDir: paths.homeDir,
    browserDir: paths.browserDir,
    configPath: prepared.snapshot.path,
    readmePath,
    composePath,
  };

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(`Teammate computer ready: ${shortenHomePath(paths.homeDir)}`);
  runtime.log(TEAMMATE_SLA);
  runtime.log(`Exec host: ${placement.effectiveHost} (gatewayExec=${String(placement.gatewayExec)})`);
  runtime.log(`README: ${shortenHomePath(readmePath)}`);
  runtime.log(`Compose overlay: ${shortenHomePath(composePath)}`);
  runtime.log(`Confirm: ${formatCliCommand("openclaw sandbox explain --json")}`);
  runtime.log(`Confirm: ${formatCliCommand("openclaw security audit")}`);
}
