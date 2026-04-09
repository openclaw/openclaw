import { resolveCliArgvInvocation } from "./argv-invocation.js";

export function shouldSkipRespawnForArgv(argv: string[]): boolean {
  return resolveCliArgvInvocation(argv).hasHelpOrVersion;
}
