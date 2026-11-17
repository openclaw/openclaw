import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { ChainStepError } from "./state-upgrade-validate.js";

const CHAIN_TIMEOUT_MS = 30 * 60_000;

export type StateUpgradeChain = (params: {
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) => Promise<{ warnings: string[] }>;

/** This build's Doctor, run against the shadow only, from the given CLI entry. */
export const createDoctorChain =
  (entry = process.argv[1], execArgv = process.execArgv): StateUpgradeChain =>
  async ({ stateDir, configPath, env, logPath }) => {
    if (!entry) {
      throw new ChainStepError("doctor", "Cannot locate the OpenClaw entry point for Doctor.");
    }
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
      // Service identity and tokens belong to the live Gateway, not the shadow run.
      if (!/^OPENCLAW_(LAUNCHD_LABEL|PROFILE|SERVICE_|GATEWAY_TOKEN|GATEWAY_PASSWORD)/u.test(key)) {
        childEnv[key] = value;
      }
    }
    // Agent-directory selectors into the live tree point at the copy; any other
    // directory is not part of the swap, so the shadow run uses its default.
    const liveStateDir = path.resolve(resolveStateDir(env));
    for (const key of ["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
      const value = env[key]?.trim();
      const inside =
        value && path.relative(liveStateDir, path.resolve(resolveUserPath(value, env)));
      childEnv[key] =
        inside && !inside.startsWith("..") && !path.isAbsolute(inside)
          ? path.join(stateDir, inside)
          : undefined;
    }
    Object.assign(childEnv, {
      OPENCLAW_STATE_DIR: stateDir,
      // Opaque identities recorded in the copy name the databases as published here.
      OPENCLAW_STATE_UPGRADE_LIVE_STATE_DIR: liveStateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_NO_RESPAWN: "1",
    });
    const log = fs.openSync(logPath, "a", 0o600);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [...execArgv, entry, "doctor", "--fix", "--non-interactive"],
          { env: childEnv, stdio: ["ignore", log, log] },
        );
        const timer = setTimeout(() => child.kill("SIGKILL"), CHAIN_TIMEOUT_MS);
        child.on("error", reject);
        child.on("exit", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      // Doctor also reports unrelated repairs; the schema check below decides success.
      return {
        warnings: code === 0 ? [] : [`Doctor exited ${code ?? "by signal"}; see ${logPath}`],
      };
    } finally {
      fs.closeSync(log);
    }
  };
