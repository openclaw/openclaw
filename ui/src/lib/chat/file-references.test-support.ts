import type { FileReference } from "../../../../src/shared/file-references.js";

export const fileReferenceFixture: FileReference = {
  schemaVersion: 1,
  namespace: "openclaw.session-file.v1",
  providerId: "session-workspace-local",
  accountId: "account-one",
  workspaceId: "workspace-one",
  rootLabel: "Synthetic workspace",
  authorizationRevision: "authorization-one",
  resolverRevision: "resolver-one",
  leaseExpiresAt: 100_000,
  objectId: "opaque-file-one",
  relativePath: "src/example.ts",
  displayLabel: "example.ts",
};

export const composerFileReferenceFixture = {
  start: 0,
  end: 15,
  reference: fileReferenceFixture,
};
