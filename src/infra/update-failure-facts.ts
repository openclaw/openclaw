import type { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { redactSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";
import type { UpdateFailureFactSchema } from "./update-run-schema.js";

export type UpdateFailureFact = z.infer<typeof UpdateFailureFactSchema>;

/** Capture diagnostics before output is reduced to a command tail. */
export function createUpdateFailureFact(
  fact: UpdateFailureFact,
  env: NodeJS.ProcessEnv = process.env,
): UpdateFailureFact {
  const context = { env, stateDir: resolveStateDir(env) };
  const line = (value: string, limit: number) => redactSupportDiagnosticLine(value, context, limit);
  return {
    check: line(fact.check, 128),
    code: line(fact.code, 80),
    ...(fact.message ? { message: line(fact.message, 200) } : {}),
    ...(fact.affectedKey ? { affectedKey: line(fact.affectedKey, 128) } : {}),
    ...(fact.pluginId ? { pluginId: line(fact.pluginId, 80) } : {}),
  };
}

export function normalizeUpdateFailureFacts(
  facts: readonly UpdateFailureFact[],
  env: NodeJS.ProcessEnv = process.env,
): UpdateFailureFact[] {
  return facts.slice(0, 5).map((fact) => createUpdateFailureFact(fact, env));
}
