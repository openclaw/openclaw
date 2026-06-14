/** Audits plugin tool descriptors at registration time and logs authoring errors. */
import { buildToolPlan } from "../tools/planner.js";
import type { ToolAvailabilityContext, ToolDescriptor } from "../tools/types.js";
import type { PluginLogger } from "./types.js";

/** Log malformed descriptor diagnostics surfaced by the tool planner. */
export function auditPluginToolDescriptors(params: {
  pluginId: string;
  descriptors: readonly ToolDescriptor[];
  availability?: ToolAvailabilityContext;
  logger: Pick<PluginLogger, "warn">;
}): void {
  if (params.descriptors.length === 0) {
    return;
  }
  buildToolPlan({
    descriptors: params.descriptors,
    availability: params.availability,
    onHiddenDiagnostic: ({ descriptor, diagnostic }) => {
      if (diagnostic.reason !== "unsupported-signal") {
        return;
      }
      params.logger.warn(
        `[plugins] tool descriptor authoring error (${params.pluginId}/${descriptor.name}): ${diagnostic.message}`,
      );
    },
  });
}
