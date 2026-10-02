import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { settleCommandProcessGroups } from "../process/command-process-custody.js";
import type {
  CommandProcessCustody,
  CommandProcessIdentity,
} from "../process/command-process-custody.types.js";
import type { CommandProcessOutcome } from "../process/exec-result.js";
import { retainCommandProcessCleanup } from "../process/exec-spawn.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "./update-doctor-result.js";
import {
  createManagedCommandProcessCustody,
  type ManagedCommandProcessAuthority,
} from "./update-managed-command-custody.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-identity.js";
import type { UpdateStepResult } from "./update-step-result.js";

const receiptSchema = z.object({
  nonce: z.string(),
  runId: z.string(),
  pid: z.number().int().nonnegative(),
  namespace: z
    .object({
      roots: z.array(z.string()).nonempty(),
      databaseIdentity: z.object({
        databasePath: z.string(),
        databaseIdentity: z.string(),
        parentIdentity: z.string(),
      }),
    })
    .optional(),
  slots: z.array(
    z.object({
      id: z.number().int().positive(),
      identity: z
        .object({
          pid: z.number().int().positive(),
          startedAt: z.number().finite().nullable(),
        })
        .optional(),
    }),
  ),
});
type Receipt = z.infer<typeof receiptSchema>;

function writeReceipt(file: string, receipt: Receipt): void {
  // Publish before native spawn: a killed writer leaves an unresolved slot,
  // never an empty inventory.
  const pending = `${file}.pending`;
  fs.writeFileSync(pending, JSON.stringify(receipt), { mode: 0o600 });
  fs.renameSync(pending, file);
}

export async function retainUpdateDoctorProcesses(
  assertCurrent?: () => void,
  authority?: ManagedCommandProcessAuthority,
): Promise<(CommandProcessCustody & Disposable) | undefined> {
  const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
  // The Windows worker retains a Job until exit, but its command owner cannot
  // publish per-command group extinction. Preserve normal completion without
  // inventing a receipt that would authorize interrupted recovery.
  if (!resultPath || process.platform === "win32") {
    return undefined;
  }
  const file = `${resultPath}.processes`;
  let raw: string;
  let ownedByDoctor = false;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    // Shipped parents do not join this channel, but the candidate still retains
    // its writer inventory if killed. Only the reserving owner may remove it.
    ownedByDoctor = true;
    raw = JSON.stringify({
      nonce: randomUUID(),
      runId: process.env.OPENCLAW_UPDATE_RUN_ID ?? "",
      pid: 0,
      slots: [],
    });
    fs.writeFileSync(file, raw, { flag: "wx", mode: 0o600 });
  }
  const receipt = receiptSchema.parse(JSON.parse(raw));
  if (receipt.pid !== 0) {
    throw new Error("Doctor process custody does not match its delegated invocation.");
  }
  if (authority) {
    assertCurrent?.();
    if (ownedByDoctor) {
      receipt.runId = authority.runId;
    } else if (receipt.runId !== authority.runId) {
      throw new Error("Doctor process custody does not match its admitted update run.");
    }
    const namespace = {
      roots: [...new Set(authority.parents.map((parent) => parent.key))],
      databaseIdentity: authority.databaseIdentity,
    };
    if (
      receipt.namespace &&
      (!isDeepStrictEqual(
        [...new Set(receipt.namespace.roots)].toSorted(),
        namespace.roots.toSorted(),
      ) ||
        !isDeepStrictEqual(receipt.namespace.databaseIdentity, namespace.databaseIdentity))
    ) {
      throw new Error("Doctor process custody does not match its admitted executor namespace.");
    }
    receipt.namespace = namespace;
  }
  receipt.pid = process.pid;
  writeReceipt(file, receipt);
  let root: string | null | undefined;
  if (!receipt.namespace) {
    const { resolveOpenClawPackageRoot } = await import("./openclaw-root.js");
    root = await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
  }
  let nativeCustody: ReturnType<typeof createManagedCommandProcessCustody> | undefined;
  let sequence = 0;
  return {
    [Symbol.dispose]() {
      if (receipt.slots.length === 0) {
        nativeCustody?.releaseAnchors();
      }
      if (ownedByDoctor && receipt.slots.length === 0) {
        fs.rmSync(file, { force: true });
      }
    },
    reserve(argv) {
      // Root discovery may be unavailable during otherwise useful diagnostics.
      // Native installation custody is required before dispatching a child.
      if (!nativeCustody) {
        const namespace = receipt.namespace ?? (root ? { roots: [root] } : undefined);
        if (!namespace) {
          throw new Error("Doctor process custody requires its installation root.");
        }
        nativeCustody = createManagedCommandProcessCustody({
          ...namespace,
          runId: receipt.runId,
          anchorOwner: `doctor:${receipt.nonce}`,
          parents: authority?.parents,
          assertCurrent,
        });
        receipt.namespace ??= {
          roots: namespace.roots,
          databaseIdentity: nativeCustody.databaseIdentity,
        };
      }
      const retained = nativeCustody.custody.reserve(argv);
      const slot: Receipt["slots"][number] = { id: ++sequence };
      receipt.slots.push(slot);
      try {
        writeReceipt(file, receipt);
      } catch (error) {
        retained.settled();
        throw error;
      }
      return {
        spawned(identity: CommandProcessIdentity) {
          retained.spawned(identity);
          slot.identity = identity;
          writeReceipt(file, receipt);
        },
        settled() {
          retained.settled();
          const index = receipt.slots.indexOf(slot);
          if (index >= 0) {
            receipt.slots.splice(index, 1);
            writeReceipt(file, receipt);
          }
        },
      };
    },
  };
}

export type UpdateDoctorProcessNamespace = {
  roots: readonly string[];
  databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
};

export function createUpdateDoctorProcessCustody(
  runId: string,
  root: string,
  resultPath: string,
  namespace: UpdateDoctorProcessNamespace = { roots: [root] },
  privateInputContract?: "delegated-doctor",
) {
  // This is the existing Doctor result IPC channel, not a new state store.
  const descriptor = {
    path: `${resultPath}.processes`,
    nonce: randomUUID(),
  };
  const roots = [...namespace.roots];
  const nativeCustody =
    process.platform === "win32"
      ? undefined
      : createManagedCommandProcessCustody({
          roots,
          runId,
          anchorOwner: `doctor:${descriptor.nonce}`,
          ...(namespace.databaseIdentity
            ? { databaseIdentity: { ...namespace.databaseIdentity } }
            : {}),
        });
  fs.writeFileSync(
    descriptor.path,
    JSON.stringify({
      nonce: descriptor.nonce,
      runId,
      pid: 0,
      slots: [],
      ...(nativeCustody
        ? { namespace: { roots, databaseIdentity: nativeCustody.databaseIdentity } }
        : {}),
    }),
    { flag: "wx", mode: 0o600 },
  );
  let mayRemove = false;
  return {
    async settle(result?: CommandProcessOutcome): Promise<UpdateStepResult | undefined> {
      const started = Date.now();
      const interrupted =
        !result ||
        result.cleanup === "forced" ||
        result.cleanup === "uncertain" ||
        result.termination !== "exit";
      const abnormal = interrupted || result?.code !== 0;
      const pid = result?.pid;
      if (pid === undefined && result?.cleanup === "normal") {
        mayRemove = true;
        return undefined;
      }
      const rootStopped =
        pid !== undefined && result?.cleanup !== "uncertain" && !isChildProcessTreeAlive({ pid });
      const rootExtinct =
        rootStopped && !(process.platform === "win32" && result?.cleanup === "forced");
      let receipt: Receipt | undefined;
      let inputWithheld = false;
      try {
        const parsed = receiptSchema.safeParse(
          JSON.parse(fs.readFileSync(descriptor.path, "utf8")),
        );
        if (
          parsed.success &&
          parsed.data.nonce === descriptor.nonce &&
          parsed.data.runId === runId
        ) {
          inputWithheld =
            privateInputContract === "delegated-doctor" &&
            result?.inputReleased === false &&
            rootStopped &&
            parsed.data.pid === 0 &&
            parsed.data.slots.length === 0;
          if (inputWithheld || pid === undefined || parsed.data.pid === pid) {
            receipt = parsed.data;
          }
        }
      } catch {
        // A missing or partial receipt cannot prove that no native work started.
      }
      // Shipped targets without this IPC retain normal completion, after the
      // original pinned namespace also confirms that no command claims remain.
      const legacyCompletion = !receipt && !interrupted && rootExtinct;
      const identities =
        receipt?.slots.flatMap((slot) => (slot.identity ? [slot.identity] : [])) ?? [];
      const pending = receipt?.slots.filter((slot) => !slot.identity).length ?? 0;
      // Withheld private input proves no Doctor writers, not whole Windows Job extinction.
      const admitted =
        (rootExtinct && (receipt !== undefined || legacyCompletion)) || inputWithheld;
      const cleanup = (async () => {
        const pids = [...identities.map((identity) => identity.pid), ...(pid ? [pid] : [])];
        if (!admitted || pid === undefined) {
          return {
            settled: false,
            pids,
            reason: "Doctor root process extinction could not be proven",
          };
        }
        try {
          // Snapshot exact native handles before joining; mutable IPC never selects this namespace.
          const retire = nativeCustody?.prepareSettlement(pid, identities);
          const groups = await settleCommandProcessGroups(identities);
          if (groups.settled && pending === 0) {
            retire?.();
          }
          return groups;
        } catch (error) {
          return { settled: false, pids, reason: formatErrorMessage(error) };
        }
      })();
      retainCommandProcessCleanup(
        cleanup.then((groups) => (groups.settled && pending === 0 ? "normal" : "uncertain")),
      );
      const groups = await cleanup;
      const settled = admitted && pending === 0 && groups.settled;
      mayRemove = settled;
      if (
        settled &&
        (inputWithheld || legacyCompletion || (!abnormal && receipt?.slots.length === 0))
      ) {
        return undefined;
      }
      const knownPid = pid ?? receipt?.pid;
      const pids = [
        ...new Set([
          ...groups.pids,
          ...(!rootExtinct || !receipt || pending > 0 ? (knownPid ? [knownPid] : []) : []),
        ]),
      ];
      const message = settled
        ? "Doctor did not finish normally, but every tracked process group stopped. Preserving migrated state; run `openclaw update repair` to finish deferred maintenance."
        : `Doctor processes remain unsettled, data-at-risk. PIDs/process groups: ${pids.join(", ") || "unavailable"}; ${!receipt ? "custody receipt unavailable" : pending > 0 ? `${pending} spawn reservations lack a process identity` : (groups.reason ?? "process extinction could not be proven")}. Keep the Gateway stopped and preserve ${descriptor.path}; resolve retained process custody before retrying \`openclaw update repair\`. Repeating repair alone cannot clear unknown reservations.`;
      return {
        name: "doctor process settlement",
        command: "settle doctor process groups",
        cwd: root,
        durationMs: Date.now() - started,
        exitCode: settled ? 0 : 1,
        ...(settled
          ? { advisory: { kind: "recoverable-maintenance" as const, message } }
          : {
              stderrTail: message,
              failureFacts: [
                { check: "openclaw doctor", code: "doctor-processes-unsettled", message },
              ],
            }),
      };
    },
    close() {
      if (mayRemove) {
        fs.rmSync(descriptor.path, { force: true });
        fs.rmSync(`${descriptor.path}.pending`, { force: true });
      }
    },
  };
}
