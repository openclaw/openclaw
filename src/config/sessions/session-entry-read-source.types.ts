import type { OpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";

/** Address of the physical store admitted by an entry read; never retains its handle. */
export type SessionEntryReadSource = Readonly<{ agentId: string; path: string }>;

export type CapturedSessionEntryReadSource = SessionEntryReadSource &
  Readonly<{
    databaseIdentity: OpenClawAgentDatabaseIdentity;
    databaseBirthtime?: string;
  }>;

export type SessionIdentityEvidenceIdentity = {
  sessionId: string;
  sessionKey?: string;
};

export type SessionIdentityEvidenceResult =
  | { status: "current"; sessionKey: string }
  | { status: "absent" }
  | {
      status: "unknown";
      reason: "ambiguous" | "read-failed" | "row-invalid" | "schema-missing";
    };
