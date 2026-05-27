import { hasHelpOrVersion } from "./argv.js";

export function shouldSkipRespawnForArgv(argv: string[]): boolean {
  return hasHelpOrVersion(argv);
}
