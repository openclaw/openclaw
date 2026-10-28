import { randomUUID } from "node:crypto";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import type { EngineConnection } from "../infra/sql-connection.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  readPersonalGitLabSecret,
  writePersonalGitLabSecret,
} from "../secrets/store/secret-store-hidden-gitlab.kernel.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { stageUserGitLabConnectionCommit } from "./user-gitlab-connection-events.js";
import {
  gitLabIssuerSchema,
  userGitLabConnectionSchema,
  type UserGitLabConnection,
  type UserGitLabConnectionCommit,
} from "./user-gitlab-connections.types.js";
import { selectResolvedUserProfileMetadataById } from "./user-profiles-internal.js";

export function validateUserGitLabIssuer(raw: string): string {
  const result = gitLabIssuerSchema.safeParse(raw);
  if (!result.success) {
    throw new Error("GitLab issuer must be a canonical HTTPS URL.");
  }
  return result.data;
}

export function parseUserGitLabConnection(raw: string, issuer: string): UserGitLabConnection {
  const result = userGitLabConnectionSchema.safeParse(safeParseJson(raw));
  if (!result.success || result.data.issuer !== issuer) {
    throw new Error("Personal GitLab state is invalid; reconnect My GitLab.");
  }
  return registerUserGitLabConnectionSecrets(result.data);
}

export function registerUserGitLabConnectionSecrets(
  record: UserGitLabConnection,
): UserGitLabConnection {
  if (record.pending) {
    registerSecretValueForRedaction(record.pending.state);
    registerSecretValueForRedaction(record.pending.verifier);
  }
  if (record.selection.kind === "connected") {
    registerSecretValueForRedaction(record.selection.tokens.accessToken);
    registerSecretValueForRedaction(record.selection.tokens.refreshToken);
  }
  return record;
}

export function isPersonalGitLabOwnerInDatabase(db: EngineConnection, owner: string): boolean {
  if (!tableExists(db, "user_profiles")) {
    return false;
  }
  const resolved = selectResolvedUserProfileMetadataById(db, owner);
  return Boolean(resolved && resolved.id === owner && !resolved.merged_into);
}

function requireOwner(db: EngineConnection, owner: string): void {
  if (!isPersonalGitLabOwnerInDatabase(db, owner)) {
    throw new Error("Personal GitLab owner changed; reconnect and try again.");
  }
}

export function readUserGitLabConnectionInDatabase(
  db: EngineConnection,
  owner: string,
  issuer: string,
): UserGitLabConnection | undefined {
  validateUserGitLabIssuer(issuer);
  requireOwner(db, owner);
  const raw = readPersonalGitLabSecret(db, owner, issuer);
  return raw === undefined ? undefined : parseUserGitLabConnection(raw, issuer);
}

export function writeUserGitLabConnectionInDatabase(
  db: EngineConnection,
  owner: string,
  issuer: string,
  next: UserGitLabConnection,
  capture?: (receipt: UserGitLabConnectionCommit) => void,
): UserGitLabConnection {
  validateUserGitLabIssuer(issuer);
  requireOwner(db, owner);
  const parsed = parseUserGitLabConnection(JSON.stringify(next), issuer);
  writePersonalGitLabSecret(db, owner, issuer, JSON.stringify(parsed));
  const receipt: UserGitLabConnectionCommit = {
    kind: "user-gitlab-connection",
    changed: [{ owner, issuer }],
  };
  if (capture) {
    capture(receipt);
  } else {
    stageUserGitLabConnectionCommit(db, receipt);
  }
  return parsed;
}

export function disconnectedUserGitLabConnection(issuer: string): UserGitLabConnection {
  validateUserGitLabIssuer(issuer);
  return { version: 1, issuer, generation: randomUUID(), selection: { kind: "disconnected" } };
}
