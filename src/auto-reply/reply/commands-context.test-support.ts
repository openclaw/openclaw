import { resolveCommandAuthorization } from "../command-auth.js";
import { buildCommandContext } from "./commands-context.js";

export function buildCommandContextForTest(
  params: Parameters<typeof buildCommandContext>[0] & { commandAuthorized: boolean },
) {
  return buildCommandContext(params, resolveCommandAuthorization(params));
}
