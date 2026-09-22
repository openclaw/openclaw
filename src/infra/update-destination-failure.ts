import type { z } from "zod";
import type { UpdateDestinationFailureSchema } from "./update-run-schema.js";

export type UpdateDestinationFailure = z.infer<typeof UpdateDestinationFailureSchema>;

export const UPDATE_DESTINATION_RECOVERY =
  "Use the destination's owning installation and service account, or correct the npm prefix mismatch before retrying: https://docs.openclaw.ai/install/update-troubleshooting#node-and-global-install-permissions. Do not overwrite another installation.";

/** Paths are normalized before recording; this projection also runs in the browser. */
export function formatUpdateDestinationFailure(fact: UpdateDestinationFailure): string {
  const paths = [
    ["prefix", fact.prefix],
    ["package", fact.packageRoot],
    ["running install", fact.runningRoot],
    ["running prefix", fact.runningPrefix],
    ["launcher", fact.launcher],
    ["launcher target", fact.launcherTarget],
  ] as const;
  return [
    `Warning: npm destination ownership ${fact.ownership}; cause ${fact.cause}; kind ${fact.destinationKind}`,
    ...paths.flatMap(([label, value]) => (value === null ? [] : [`${label} \`${value}\``])),
    `Next step: ${UPDATE_DESTINATION_RECOVERY}`,
  ].join("; ");
}
