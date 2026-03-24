import { hasHelpOrVersion } from "./argv.js";

/** Returns true when argv contains --help or --version, meaning the process should not be respawned into a different runtime. */
export function shouldSkipRespawnForArgv(argv: string[]): boolean {
  return hasHelpOrVersion(argv);
}
