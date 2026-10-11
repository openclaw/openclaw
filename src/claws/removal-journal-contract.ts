import { z } from "zod";
import type { AgentDeletionSessionStoreSafetyInput } from "../agents/agent-delete-session-store-safety.worker-contract.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDatabaseFileIdentity } from "../infra/sqlite-worker-identity.js";
import type { AgentDeletionJournalTransport } from "../state/agent-deletion-journal-transport.js";
import type { AgentDeletionJournalEntry } from "../state/agent-deletion-journal.types.js";
import { clawMonitorCleanupBindingSchema } from "./monitor-cleanup-contract.js";
import { MAX_CLAW_MANIFEST_BYTES } from "./source-limits.js";

const text = z.string().min(1).max(4096);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const agentId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/u)
  .max(128);

export const clawRemovalSourceIdentitySchema = z
  .object({ canonicalPath: text, key: text, birthtime: text })
  .strict()
  .refine((value) => {
    try {
      readDatabaseFileIdentity(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid original database identity.");
export const clawRemovalLeaseSchema = z
  .object({ scope: z.literal("core:agent-deletion"), key: agentId, owner: text })
  .strict();

export const clawRemovalJournalRequestSchema = z
  .object({
    phase: z.enum(["begin", "rollback"]),
    agentId,
    operationId: text,
    binding: clawMonitorCleanupBindingSchema,
    sourceIdentity: clawRemovalSourceIdentitySchema,
    lease: clawRemovalLeaseSchema,
    expectedInstallDigest: digest,
    expectedJournalDigest: digest,
    configDigest: digest,
  })
  .strict()
  .refine(
    (input) =>
      input.lease.key === input.agentId &&
      Buffer.byteLength(JSON.stringify(input)) <= MAX_CLAW_MANIFEST_BYTES,
    "Claw removal journal request differs from its deletion lease or exceeds the byte limit.",
  );

const journal = z
  .object({
    agentId,
    operationId: text,
    agentDir: text,
    workspaceDir: z.string().max(4096),
    sessionsDir: text,
    databasePaths: z.array(text),
    cleanupPaths: z.array(
      z
        .object({
          path: text,
          canonicalPath: text,
          parentPath: text,
          kind: z.enum(["target", "symlink"]),
          sourcePaths: z.array(text),
          dev: z.number().nullable(),
          ino: z.number().nullable(),
          coversDescendants: z.boolean(),
          done: z.boolean(),
          note: z.string().optional(),
        })
        .strict(),
    ),
    createdAt: z.number().finite(),
    cleanupCompleted: z.boolean(),
    deleteFiles: z.boolean(),
  })
  .strict();

export const clawRemovalJournalResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), journal: journal.nullable() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);

/** The released Claw transport represents only its existing retirement flow. */
export function serializeClawRemovalJournal(entry: AgentDeletionJournalEntry | null | undefined) {
  if (!entry) {
    return null;
  }
  if (entry.phase !== "retiring") {
    throw new Error(`Agent ${entry.agentId} deletion is still draining.`);
  }
  const { phase: _phase, ...wireJournal } = entry;
  return wireJournal;
}

type ClawRemovalJournalRequest = z.infer<typeof clawRemovalJournalRequestSchema>;
export type ClawRemovalJournalWorkerInput = {
  nonce: string;
  request: ClawRemovalJournalRequest;
  config: OpenClawConfig;
  sessionStoreSafety: AgentDeletionSessionStoreSafetyInput | null;
};

export type ClawRemovalJournalGateway = (
  input: Parameters<AgentDeletionJournalTransport>[0] & {
    expectedInstallDigest: string;
    configDigest: string;
  },
  authority: Parameters<AgentDeletionJournalTransport>[1],
) => ReturnType<AgentDeletionJournalTransport>;
