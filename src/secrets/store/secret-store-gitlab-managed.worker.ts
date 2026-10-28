import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import {
  writeHiddenGitLabSecretInDatabase,
  readHiddenGitLabSecretInDatabase,
  listHiddenGitLabSecretsInDatabase,
  deleteHiddenGitLabSecretInDatabase,
} from "./secret-store-hidden-managed-gitlab.kernel.js";
import { classifyHiddenGitLabStoreName } from "./secret-store-managed-gitlab-names.js";
import type { HiddenGitLabStorePrefix } from "./secret-store-managed-gitlab-names.js";
import { withMissingSecretStoreFallback } from "./secret-store-sqlite.js";

export const gitlabManagedOperations = {
  "gitlabManagedSecrets.read": (
    { name, now }: { name: string; now: number },
    { open }: WorkerWriteOperationContext,
  ) => readHiddenGitLabSecretInDatabase(open().db, name, now),
  "gitlabManagedSecrets.list": (
    { prefix, now }: { prefix?: HiddenGitLabStorePrefix; now: number },
    { open }: WorkerWriteOperationContext,
  ) => listHiddenGitLabSecretsInDatabase(open().db, prefix, now),
  "gitlabManagedSecrets.write": (
    input: {
      name: string;
      value: string;
      expectedValue?: string;
      expectedAbsent?: boolean;
      updatedBy?: string | null;
      now: number;
    },
    { write }: WorkerWriteOperationContext,
  ) =>
    write(({ db }) => writeHiddenGitLabSecretInDatabase(db, input), {
      operationLabel: "secrets.store.write",
    }),
  "gitlabManagedSecrets.delete": (
    { name }: { name: string },
    { write }: WorkerWriteOperationContext,
  ) =>
    write(({ db }) => deleteHiddenGitLabSecretInDatabase(db, name), {
      operationLabel: "secrets.store.delete-hidden-gitlab",
    }),
  "gitlabManagedSetup.consume": (
    {
      name,
      state,
      initiatorProfileId,
      now,
    }: { name: string; state: string; initiatorProfileId: string; now: number },
    context: WorkerWriteOperationContext,
  ): string | undefined => {
    if (classifyHiddenGitLabStoreName(name) !== "setup") {
      return undefined;
    }
    return withMissingSecretStoreFallback(
      () =>
        context.write(
          ({ db }) => {
            const raw = readHiddenGitLabSecretInDatabase(db, name, now);
            if (!raw) {
              return undefined;
            }
            let record: Record<string, unknown> | undefined;
            try {
              record = asOptionalRecord(JSON.parse(raw));
            } catch {
              return undefined;
            }
            if (
              record?.state !== state ||
              record.initiatorProfileId !== initiatorProfileId ||
              typeof record.expiresAtMs !== "number" ||
              record.expiresAtMs <= now
            ) {
              return undefined;
            }
            deleteHiddenGitLabSecretInDatabase(db, name);
            return raw;
          },
          { operationLabel: "secrets.store.consume-gitlab-setup-handoff" },
        ),
      undefined,
    );
  },
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type GitLabManagedWorkerOperations = WorkerOperations<typeof gitlabManagedOperations>;
