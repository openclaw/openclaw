import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { ModelAccountRole } from "../gateway/model-account-authority.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "./openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import { parseUserModelAuthProfileId } from "./user-model-account-id.js";
import { registerUserModelAuthProfileSecrets } from "./user-model-accounts.js";
import {
  captureUserProfileAuthorityRead,
  fenceUserProfileModelAccountLinks,
} from "./user-profile-events.js";

type AccountOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
  context?: OpenClawStateWorkerContext;
};
type Mutation =
  | "userProfiles.modelAccount.connect"
  | "userProfiles.modelAccount.link"
  | "userProfiles.modelAccount.unlink";

function mutationAdmission(
  context: OpenClawStateWorkerContext,
  profileId: string,
  assertCurrent: (roles?: readonly ModelAccountRole[]) => void,
  authorityProfileIds: readonly string[] = [],
) {
  return {
    createAdmission: ((operation) => {
      let fence: ReturnType<typeof fenceUserProfileModelAccountLinks> | undefined;
      const admission = createSqliteWorkerOperationAdmission((request, grant) => {
        if (
          (request.stage !== "transaction" && request.stage !== "commit") ||
          !isRecord(request.facts) ||
          request.facts.kind !== "model-account-links" ||
          request.facts.profileId !== profileId ||
          !Array.isArray(request.facts.roles) ||
          !request.facts.roles.every(
            (role): role is ModelAccountRole =>
              isRecord(role) &&
              typeof role.profileId === "string" &&
              (role.role === null || typeof role.role === "string"),
          ) ||
          request.facts.roles.length !== authorityProfileIds.length ||
          !request.facts.roles.every((role, index) => role.profileId === authorityProfileIds[index])
        ) {
          throw new Error("Personal account mutation requires exact transaction admission");
        }
        context.admission.assertCurrent();
        assertCurrent(request.facts.roles);
        if (request.stage === "commit") {
          fence ??= fenceUserProfileModelAccountLinks(context.admission, profileId);
        }
        grant();
      });
      void operation.settled.then((outcome) =>
        fence?.settle(outcome.kind !== "unknown" || admission.committed !== undefined),
      );
      return { admission, nativeLocations: [context.admission.databasePath] };
    }) satisfies SqliteWorkerAdmissionFactory,
  };
}

function mutate<Key extends Mutation>(
  type: Key,
  input: OpenClawStateWorkerOperations[Key]["input"],
  assertCurrent: (roles?: readonly ModelAccountRole[]) => void,
  options: AccountOptions,
) {
  const context = options.context ?? captureOpenClawStateWorkerContext(options);
  const captured = structuredClone(input);
  assertCurrent();
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type, input: captured }),
    mutationAdmission(context, captured.profileId, assertCurrent, captured.authorityProfileIds),
  );
}

/** The provider compares identities before BEGIN; the worker compares the exact current rows. */
export function connectUserModelAccountAsync(
  params: {
    ownerProfileId: string;
    credential: AuthProfileCredential;
    matchesCredential?: (credential: AuthProfileCredential) => boolean;
    assertCurrent: (roles?: readonly ModelAccountRole[]) => void;
    authorityProfileIds?: readonly string[];
  },
  options: AccountOptions = {},
) {
  const context = options.context ?? captureOpenClawStateWorkerContext(options);
  const credential = structuredClone(params.credential);
  const { ownerProfileId: profileId, assertCurrent, matchesCredential } = params;
  const authorityProfileIds = [...(params.authorityProfileIds ?? [])];
  assertCurrent();
  return runOpenClawStateWorkerOperation(
    context,
    async (scope) => {
      const candidate = await scope.execute({
        type: "userProfiles.modelAccount.selected",
        input: { profileId, provider: credential.provider },
      });
      context.admission.assertCurrent();
      assertCurrent();
      if (candidate) {
        registerUserModelAuthProfileSecrets(candidate.credential);
      }
      const replacement =
        candidate && matchesCredential?.(structuredClone(candidate.credential))
          ? candidate
          : undefined;
      return scope.execute({
        type: "userProfiles.modelAccount.connect",
        input: { profileId, credential, replacement, authorityProfileIds },
      });
    },
    mutationAdmission(context, profileId, assertCurrent, authorityProfileIds),
  );
}

export function setUserProfileAuthLinkAsync(
  params: {
    profileId: string;
    provider: string;
    authProfileId: string;
    assertCurrent: (roles?: readonly ModelAccountRole[]) => void;
    authorityProfileIds?: readonly string[];
  },
  options: AccountOptions = {},
) {
  const { assertCurrent, ...input } = params;
  return mutate("userProfiles.modelAccount.link", input, assertCurrent, options);
}

export function clearUserProfileAuthLinkAsync(
  params: Omit<Parameters<typeof setUserProfileAuthLinkAsync>[0], "authProfileId">,
  options: AccountOptions = {},
) {
  const { assertCurrent, ...input } = params;
  return mutate("userProfiles.modelAccount.unlink", input, assertCurrent, options);
}

async function read<
  Key extends "userProfiles.modelAccount.list" | "userProfiles.modelAccount.selected",
>(type: Key, input: OpenClawStateWorkerOperations[Key]["input"], options: AccountOptions) {
  const context = options.context ?? captureOpenClawStateWorkerContext(options);
  const captured = structuredClone(input);
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type, input: captured }),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  return result;
}

export async function listUserModelAccountsAsync(
  params: { profileId: string; cursor?: string },
  options: AccountOptions = {},
) {
  return (await read("userProfiles.modelAccount.list", params, options)) ?? { accounts: [] };
}

export async function readUserModelAccountSummaryAsync(
  params: { profileId: string; authProfileId: string },
  options: AccountOptions = {},
) {
  const context = options.context ?? captureOpenClawStateReadWorkerContext(options);
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "userModelAccounts.summary", ...params },
    { context, current: true, preferIndependentWarmRead: true },
  );
  context.admission.assertCurrent();
  if (reply && (!reply.ok || reply.type !== "userModelAccounts.summary")) {
    throw new Error(reply.ok ? "Unexpected personal account summary reply" : reply.message);
  }
  return reply?.account;
}

/** Account pins retain the identity writer's authority, independently of default links. */
export async function prepareUserModelAccountAuthority(
  params: { profileId: string; authProfileId: string },
  options: AccountOptions = {},
) {
  const { profileId, authProfileId } = params;
  const locator = parseUserModelAuthProfileId(authProfileId);
  if (!locator) {
    return undefined;
  }
  const context = options.context ?? captureOpenClawStateWorkerContext(options);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const authority = await captureUserProfileAuthorityRead(
      context.admission,
      undefined,
      "identity",
    );
    const account = await readUserModelAccountSummaryAsync(
      { profileId, authProfileId },
      { context },
    );
    if (!account) {
      return undefined;
    }
    // Merge publishes every changed alias; a link edit or reconnect keeps this pin valid.
    const isCurrent = authority.bind([profileId, locator.ownerProfileId]);
    if (isCurrent) {
      return { provider: account.provider, isCurrent };
    }
  }
  throw new Error("Personal model account ownership changed while preparing the selection");
}

/** Only provider preparation consumes the private selected credential, never an RPC reply. */
export async function readSelectedUserModelAccountAsync(
  profileId: string,
  provider: string,
  options: AccountOptions = {},
) {
  const result = await read("userProfiles.modelAccount.selected", { profileId, provider }, options);
  if (result) {
    registerUserModelAuthProfileSecrets(result.credential);
  }
  return result;
}

export { listUserProfileAuthLinksAsync } from "./user-model-accounts.js";
