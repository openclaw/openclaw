import type { RuntimeEnv } from "../../runtime.js";
import type { ModelRow } from "./list.types.js";
import { modelsListLogic } from "./list.logic.js";
import { printModelTable } from "./list.table.js";
import { ensureFlagCompatibility } from "./shared.js";

export async function modelsListCommand(
  opts: {
    all?: boolean;
    local?: boolean;
    provider?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);

  const { rows, error } = await modelsListLogic({
    all: opts.all,
    local: opts.local,
    provider: opts.provider,
  });

  if (error) {
    runtime.error(error);
  }

  if (rows.length === 0) {
    runtime.log("No models found.");
    return;
  }

  printModelTable(rows, runtime, opts);
}
