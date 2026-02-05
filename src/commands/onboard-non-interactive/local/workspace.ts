import type { OpenClawConfig } from "../../../config/config.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { resolveUserPath } from "../../../utils.js";

export function resolveNonInteractiveWorkspaceDir(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  defaultWorkspaceDir: string;
}) {
  const raw = (
    params.opts.workspace ??
    params.baseConfig.agents?.defaults?.workspace ??
    params.defaultWorkspaceDir
  ).trim();
  let resolved = resolveUserPath(raw);

  // Docker container safety: if the workspace path looks like a macOS/host path
  // but we're in a Linux container, fall back to the container-native default.
  if (process.platform === "linux" && resolved.startsWith("/Users/")) {
    resolved = resolveUserPath(params.defaultWorkspaceDir);
  }

  return resolved;
}
