import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type AgentDatabaseOwner = { db: DatabaseSync };
export type OpenClawAgentDatabaseIdentity = string | symbol;

const identities = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseIdentities"),
  () =>
    new WeakMap<
      DatabaseSync,
      { identity: OpenClawAgentDatabaseIdentity; incarnation: string; filename: string }
    >(),
);

/** Prepare physical and connection identity once at open; cached aliases are not resolved again. */
export function registerOpenClawAgentDatabaseIdentity(db: DatabaseSync): void {
  const filename = db.location() ?? "";
  const file = filename ? statSync(filename, { bigint: true }) : undefined;
  const identity = file ? `${file.dev}:${file.ino}` : Symbol("incognito-agent-database");
  identities.set(db, { identity, incarnation: randomUUID(), filename });
}

/** Reuse facts captured at open; aliases must never be resolved again at a handoff. */
export function readOpenClawAgentDatabaseIdentity(database: AgentDatabaseOwner) {
  const prepared = identities.get(database.db);
  if (prepared === undefined) {
    throw new Error("OpenClaw agent database identity was not prepared at open");
  }
  return prepared;
}

export type OpenClawAgentDatabaseClaim = {
  identity: OpenClawAgentDatabaseIdentity;
  /** Changes on reopen even when the underlying file is unchanged. */
  incarnation: string;
  isCurrent: () => boolean;
  assertCurrent: () => void;
  release: () => void;
};

export function createOpenClawAgentDatabaseClaim(
  database: AgentDatabaseOwner,
  release: () => void,
): OpenClawAgentDatabaseClaim {
  let released = false;
  const isCurrent = () => !released && database.db.isOpen;
  const { identity, incarnation } = readOpenClawAgentDatabaseIdentity(database);
  return {
    identity,
    incarnation,
    isCurrent,
    assertCurrent: () => {
      if (!isCurrent()) {
        throw new Error("OpenClaw agent database claim is no longer current");
      }
    },
    release: () => {
      if (!released) {
        released = true;
        release();
      }
    },
  };
}
