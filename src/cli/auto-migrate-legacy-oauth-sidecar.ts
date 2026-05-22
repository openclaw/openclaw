import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";

const COOL_OFF_FILENAME = "legacy-oauth-sidecar-migration-declined";
const COOL_OFF_TTL_MS = 24 * 60 * 60 * 1000;

const SKIPPED_PRIMARIES = new Set(["doctor", "update", "help", "completion", "version"]);

type AutoMigrateInteractivePrompter = {
  confirm: (params: { message: string; initialValue?: boolean }) => Promise<boolean | symbol>;
};

function hasSidecarFiles(env: NodeJS.ProcessEnv): boolean {
  const sidecarDir = path.join(resolveOAuthDir(env), "auth-profiles");
  try {
    return fs
      .readdirSync(sidecarDir, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(".json"));
  } catch {
    return false;
  }
}

function resolveDeclineMarkerPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), COOL_OFF_FILENAME);
}

function shouldSkip(params: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  isInteractiveTty: () => boolean;
  now: number;
}): boolean {
  if (process.platform !== "darwin") {
    return true;
  }
  if (!params.isInteractiveTty()) {
    return true;
  }
  const env = params.env;
  if (
    env.OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR === "0" ||
    env.OPENCLAW_NON_INTERACTIVE === "1" ||
    env.CI === "true" ||
    env.CI === "1" ||
    env.OPENCLAW_AUTH_STORE_READONLY === "1"
  ) {
    return true;
  }
  const invocation = resolveCliArgvInvocation(params.argv);
  if (invocation.hasHelpOrVersion) {
    return true;
  }
  if (invocation.primary && SKIPPED_PRIMARIES.has(invocation.primary)) {
    return true;
  }
  if (!hasSidecarFiles(env)) {
    return true;
  }
  try {
    const stat = fs.statSync(resolveDeclineMarkerPath(env));
    if (params.now - stat.mtimeMs < COOL_OFF_TTL_MS) {
      return true;
    }
  } catch {
    // No marker; nothing to skip on.
  }
  return false;
}

export async function maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  prompter?: AutoMigrateInteractivePrompter;
  isInteractiveTty?: () => boolean;
}): Promise<void> {
  const env = params.env ?? process.env;
  const isInteractiveTty = params.isInteractiveTty ?? defaultIsInteractiveTty;
  const now = params.now ?? Date.now;

  if (shouldSkip({ argv: params.argv, env, isInteractiveTty, now: now() })) {
    return;
  }

  const [{ readBestEffortConfig }, { maybeRepairLegacyOAuthSidecarProfiles }, clack] =
    await Promise.all([
      import("../config/io.js"),
      import("../commands/doctor-auth-oauth-sidecar.js"),
      import("@clack/prompts"),
    ]);
  const prompter = params.prompter ?? { confirm: (p) => clack.confirm(p) };

  let declined = false;
  try {
    const result = await maybeRepairLegacyOAuthSidecarProfiles({
      cfg: await readBestEffortConfig(),
      env,
      prompter: {
        confirmAutoFix: async (p) => {
          const answer = await prompter.confirm({
            message: typeof p.message === "string" ? p.message : String(p.message),
            initialValue: p.initialValue ?? true,
          });
          if (clack.isCancel(answer) || !answer) {
            declined = true;
            return false;
          }
          return answer;
        },
      },
    });

    const markerPath = resolveDeclineMarkerPath(env);
    if (declined && result.detected.length > 0) {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, "utf8");
    } else if (result.changes.length > 0) {
      fs.rmSync(markerPath, { force: true });
    }
  } catch {
    // Auto-migration must never block the user's actual command. Doctor remains
    // the explicit fallback.
  }
}

function defaultIsInteractiveTty(): boolean {
  const stdinTty = process.stdin.isTTY ?? false;
  const stdoutTty = process.stdout.isTTY ?? false;
  return stdinTty && stdoutTty;
}
