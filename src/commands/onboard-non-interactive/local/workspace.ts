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
  return resolveUserPath(raw);
}
