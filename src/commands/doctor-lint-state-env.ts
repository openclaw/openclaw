import { resolveConfigPath, resolveStateDir } from "../config/paths.js";

export async function withDoctorLintStateEnv<T>(
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
): Promise<T> {
  const stateDir = resolveStateDir(env);
  const overrides = {
    OPENCLAW_CONFIG_PATH: resolveConfigPath(env, stateDir),
    OPENCLAW_STATE_DIR: stateDir,
  };
  const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const);
  // Doctor checks run serially. Scope ambient auth/global-store owners together,
  // restoring the enclosing private view even when a detector throws.
  Object.assign(process.env, overrides);
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
