import { OPENCLAW_BUILD_CAPABILITIES } from "../build-capabilities.js";
import { hasFlag } from "./argv.js";

/** Root `--version` output; `--json` adds the capabilities this build declares to deploy tooling. */
export function formatRootVersionOutput(
  argv: string[],
  version: string,
  commit: string | null,
): string {
  if (hasFlag(argv, "--json")) {
    return JSON.stringify({ version, commit, capabilities: OPENCLAW_BUILD_CAPABILITIES });
  }
  return commit ? `OpenClaw ${version} (${commit})` : `OpenClaw ${version}`;
}
