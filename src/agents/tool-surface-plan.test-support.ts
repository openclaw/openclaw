import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareAgentToolSurfacePresentation } from "./tool-surface-plan.js";

export function createToolSurfacePresentationForTest(
  config: OpenClawConfig = { tools: { codeMode: false, toolSearch: false } },
) {
  return prepareAgentToolSurfacePresentation({
    config,
    toolsEnabled: true,
    isRawModelRun: false,
    forceDirectMessageTool: false,
  });
}
