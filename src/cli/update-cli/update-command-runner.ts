import type { UpdateCommandOptions } from "../update-cli/shared.js";
import { withUpdateRuntimeActivationPolicy } from "./update-command-service-env.js";
import { updateCommand } from "./update-command.js";

export async function runUpdateCommand(inputOpts: UpdateCommandOptions): Promise<void> {
  return await withUpdateRuntimeActivationPolicy(inputOpts.restart !== false, () =>
    updateCommand(inputOpts),
  );
}
