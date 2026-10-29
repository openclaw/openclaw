import { formatCliCommand } from "../cli/command-format.js";
import type { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

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
