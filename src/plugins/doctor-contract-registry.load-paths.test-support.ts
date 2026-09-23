import path from "node:path";

export function makeHermeticDoctorEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: stateDir,
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
}
