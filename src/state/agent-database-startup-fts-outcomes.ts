import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerAdmissionRequest } from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

// The Gateway owns attempts, including failed worker generations, for its entire process lifetime.
type Outcome = { statePath: string; message: string; repaired: boolean };
const attempts = resolveGlobalSingleton(
  Symbol.for("openclaw.startupFtsRepairs"),
  () => new Map<string, Outcome>(),
);

function beginAgentDatabaseStartupFtsRepair(pathname: string, statePath: string): void {
  if (attempts.has(pathname)) {
    throw new Error(
      `Startup FTS repair was already attempted for ${pathname}. Run openclaw doctor --fix.`,
    );
  }
  attempts.set(pathname, {
    statePath,
    message: `Startup FTS repair did not complete for ${pathname}. Run openclaw doctor --fix.`,
    repaired: false,
  });
}

function recordAgentDatabaseStartupFtsRepair(
  pathname: string,
  message: string,
  repaired: boolean,
): void {
  const attempt = attempts.get(pathname);
  if (!attempt) {
    throw new Error("Startup FTS repair has no admitted attempt");
  }
  attempts.set(pathname, { ...attempt, message, repaired });
  createSubsystemLogger("state/agent-db").warn(message);
}

export function listAgentDatabaseStartupFtsRepairs(): Outcome[] {
  const statePath = resolveOpenClawStateSqlitePath(process.env);
  return [...attempts.values()].filter((attempt) => attempt.statePath === statePath);
}

/** Consume startup repair facts under the native generation's current request authority. */
export function handleAgentDatabaseStartupFtsRepair(
  request: SqliteWorkerAdmissionRequest,
  pathname: string,
  statePath: string,
  assertCurrent: () => void,
): boolean {
  const facts = request.facts;
  if (
    request.stage !== "prepare" ||
    !isRecord(facts) ||
    (facts.kind !== "agent-startup-fts-begin" && facts.kind !== "agent-startup-fts-result")
  ) {
    return false;
  }
  assertCurrent();
  if (facts.kind === "agent-startup-fts-begin") {
    beginAgentDatabaseStartupFtsRepair(pathname, statePath);
  } else if (typeof facts.message === "string" && typeof facts.repaired === "boolean") {
    recordAgentDatabaseStartupFtsRepair(pathname, facts.message, facts.repaired);
  } else {
    throw new Error("Invalid startup FTS repair outcome");
  }
  return true;
}
