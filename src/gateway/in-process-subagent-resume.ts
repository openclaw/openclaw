import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { TrustedSubagentResume } from "./session-subagent-resume.js";

// Published host runtime and source tools must redeem the same process-owned binding.
const resumes = resolveGlobalSingleton<WeakMap<object, TrustedSubagentResume>>(
  Symbol.for("openclaw.inProcessSubagentResumes"),
  () => new WeakMap(),
);

/** Associates host-owned resume authority without widening request, client, or SDK types. */
export function bindInProcessSubagentResume<T extends object>(
  carrier: T,
  resume: TrustedSubagentResume | undefined,
): T {
  if (resume) {
    resumes.set(carrier, resume);
  }
  return carrier;
}

/** Reads only authority attached to this exact in-process carrier, never serialized fields. */
export function readInProcessSubagentResume(
  carrier: object | null | undefined,
): TrustedSubagentResume | undefined {
  return carrier ? resumes.get(carrier) : undefined;
}
