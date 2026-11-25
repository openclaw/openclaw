import { userInfo } from "node:os";

/** @param {NodeJS.ProcessEnv} source @returns {NodeJS.ProcessEnv} */
export function managedSetupPodmanEnv(source) {
  // Vitest/QA deliberately replace HOME and XDG paths. The host engine retains
  // its real OS-user storage; guests still receive only their isolated inputs.
  const user = userInfo();
  const env = { ...source, HOME: user.homedir, USER: user.username, LOGNAME: user.username };
  delete env.XDG_RUNTIME_DIR;
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  return env;
}
