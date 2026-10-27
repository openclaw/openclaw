import fs from "node:fs/promises";
import { formatCliCommand } from "../cli/command-format.js";
import { redactTextForSupport } from "../logging/diagnostic-support-redaction.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import type { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import { UpdatePreMutationError } from "./update-pre-mutation-error.js";

/** Preserve startup diagnostics before the failed helper's private directory is removed. */
export async function readHandoffStartupFailure(
  error: unknown,
  logPath: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  let tail: string;
  try {
    const log = await fs.open(logPath, "r");
    try {
      const { size } = await log.stat();
      const buffer = Buffer.alloc(Math.min(size, 8192));
      const { bytesRead } = await log.read(buffer, 0, buffer.length, size - buffer.length);
      tail = buffer.toString("utf8", 0, bytesRead);
      // A partial first line may have lost the key identifying a secret value.
      if (size > buffer.length) {
        const newline = tail.indexOf("\n");
        tail = newline < 0 ? "" : tail.slice(newline + 1);
      }
    } finally {
      await log.close();
    }
  } catch {
    return error;
  }
  const lines = redactTextForSupport(tail)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) => line && !/^at |^Node\.js v|(?:^|\] )managed update helper completed/u.test(line),
    );
  const primary = lines.find((line) =>
    /\b(?:\w*Error(?::| \[)|Node \S+ is unsupported)/u.test(line),
  );
  const diagnostics = [...new Set([...(primary ? [primary] : []), ...lines.slice(-2)])].map(
    (line) => createUpdateErrorFact("managed-service", new Error(line), env),
  );
  if (!diagnostics.length) {
    return error;
  }
  const cause = createUpdateErrorFact("managed-service", error, env);
  return new UpdatePreMutationError(
    "managed-service-handoff-failed",
    [cause.message, ...diagnostics.map((fact) => fact.message)].join("\n"),
    { cause: error, failureFacts: [cause, ...diagnostics] },
  );
}

type HandoffStore = ReturnType<typeof createManagedHandoffLeaseStore>;

/** A busy lease is custody, not proof that its updater is still running. */
export function describeManagedHandoffBlocker(
  root: string,
  owner: string | undefined,
  store: Pick<HandoffStore, "read" | "inspectProcessIdentity"> | undefined,
  env: NodeJS.ProcessEnv,
  pending = "handoff settlement is pending",
): string {
  let detail = pending;
  const statusCommand = formatCliCommand("openclaw update status", env);
  const repairCommand = formatCliCommand("openclaw update repair", env);
  const guidance = `Check \`${statusCommand}\`. If the updater has exited, run \`${repairCommand}\` from a terminal outside the Gateway; repair verifies owners and children before releasing custody. Do not delete the update lock.`;
  try {
    const held = store?.read(root);
    if (store && held?.kind === "current") {
      const lease = held.lease;
      const custody =
        lease.version === 4
          ? "cancelled update custody"
          : lease.version === 3
            ? "retained native custody"
            : lease.action.kind === "triage"
              ? `triage/repair lease (${lease.action.phase})`
              : "update lease";
      const identity = (role: "helper" | "executor") => {
        const status = store.inspectProcessIdentity(lease[role]);
        const stateLabel =
          status === "mismatch" ? "identity changed" : status === "unknown" ? "unverified" : status;
        return `${role} PID ${lease[role].pid} (${stateLabel})`;
      };
      return `Update blocked by ${custody}: owner ${lease.owner}, lease version ${lease.version}, ${identity("helper")}, ${identity("executor")}, last activity ${new Date(lease.updatedAt).toISOString()}. ${guidance}`;
    }
    if (held?.kind === "unreadable") {
      detail = "the retained lease could not be read; its custody is unverified";
    }
  } catch {
    // Diagnostics must not turn a known refusal into a new admission failure.
    detail = "the retained lease or its process identities could not be verified";
  }
  return `Update blocked by managed handoff ${owner || "(owner unavailable)"}: ${detail}. ${guidance}`;
}
