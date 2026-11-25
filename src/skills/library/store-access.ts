import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { operatorRoleSubject } from "../../gateway/operator-role-enforcement.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { captureUserProfileAuthorityRead } from "../../state/user-profile-events.js";
import {
  hasMultipleResidentSessionSharingIdentities,
  readResidentUserProfileIdentity,
} from "../../state/user-profile-list.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type {
  SkillLibraryReadInput,
  SkillLibraryReadQueries,
  SkillLibraryWorkerAuthority,
} from "./read.contract.js";
import {
  captureSkillLibraryAuthorityRead,
  fenceSkillLibraryMutationAuthority,
} from "./store-authority.js";
import type { SkillLibraryAuthority } from "./store.js";
import type { SkillLibraryWorkerOperations } from "./store.worker-contract.js";

/** Capture the original physical store and host policy before filesystem or worker waits. */
export function captureSkillLibraryAccess(
  authority: SkillLibraryAuthority,
  options: OpenClawStateDatabaseOptions = {},
) {
  authority.assertCurrent();
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = captureOpenClawStateWorkerContext({
    path: options.database?.path ?? options.path,
    env,
  });
  const roles = structuredClone(authority.getConfig().gateway?.roles);
  const input: SkillLibraryWorkerAuthority = {
    roleSubject:
      authority.getConfig().gateway?.openclawId?.enabled && authority.profileId
        ? operatorRoleSubject(readResidentUserProfileIdentity(authority.profileId))
        : { profileId: authority.profileId, openclawIdMember: false },
    profileId: authority.profileId,
    namespace: authority.namespace,
    scopes: [...authority.scopes],
    ownerDevice: authority.ownerDevice,
    config: { gateway: { roles } },
  };
  const pinned = { path: context.admission.databasePath, env: { ...env, ...context.environment } };
  // Roles and scopes are admitted once above; only Stop and the database fence end access.
  const assertCurrent = () => {
    context.admission.assertCurrent();
    authority.assertCurrent();
  };
  return {
    options: pinned,
    assertCurrent,
    async read<K extends keyof SkillLibraryReadQueries>(
      kind: K,
      params: SkillLibraryReadQueries[K]["input"],
    ) {
      assertCurrent();
      const library = captureSkillLibraryAuthorityRead(context.admission);
      const assertSource = () => {
        assertCurrent();
        library.assertCurrent();
      };
      const profiles = await captureUserProfileAuthorityRead(context.admission);
      assertSource();
      const commandInput = {
        kind,
        params,
        authority: input,
        ...(kind === "session" ? { sessionFacts: captureSessionFacts() } : {}),
      } as SkillLibraryReadInput; // SAFETY: K binds the captured kind and parameters in SkillLibraryReadQueries.
      // Upload progress changes independently of published library entries.
      const cacheKey = kind === "upload" ? undefined : JSON.stringify(commandInput);
      const cached = cacheKey === undefined ? undefined : library.read(cacheKey);
      const reply =
        cached ??
        (await executeExistingOpenClawStateRead(
          pinned,
          { type: "skillLibrary.read", input: commandInput },
          { context, current: true },
        ));
      assertSource();
      if (!reply) {
        if (kind !== "seed") {
          throw new SkillLibraryError("NOT_FOUND", "Skill library is unavailable.");
        }
        // SAFETY: A missing store has no default selections; this branch has the seed query kind.
        const value = [] as SkillLibraryReadQueries[K]["output"];
        return { value, assertCurrent: assertSource };
      }
      if (!reply.ok || reply.type !== "skillLibrary.read" || reply.kind !== kind) {
        throw new Error("Unexpected skill library read result");
      }
      // Profile changes invalidate the cached reply; they do not refuse a started read.
      const profileCurrent = profiles.bind(reply.profileIds);
      if (cacheKey !== undefined && !cached && profileCurrent) {
        library.remember(cacheKey, reply, profileCurrent);
      }
      // SAFETY: The typed read registry binds output to kind, checked against K above.
      const value = reply.value as SkillLibraryReadQueries[K]["output"];
      return { value, assertCurrent: assertSource };
    },
    async write<K extends keyof SkillLibraryWorkerOperations>(
      type: K,
      params: Omit<SkillLibraryWorkerOperations[K]["input"], "authority">,
    ): Promise<SkillLibraryWorkerOperations[K]["output"]> {
      assertCurrent();
      const command = {
        type,
        input: {
          ...params,
          authority: input,
        } as SkillLibraryWorkerOperations[K]["input"], // SAFETY: K binds this input to the registry operation.
      };
      let admission: SqliteWorkerOperationAdmission | undefined;
      let publication: Promise<void> | undefined;
      let prepared: unknown;
      try {
        return await runOpenClawStateWorkerOperation(
          context,
          async (scope) => {
            try {
              return await scope.execute(command);
            } catch (error) {
              await publication;
              if (admission?.committed && isDeepStrictEqual(admission.committed.facts, prepared)) {
                // SAFETY: The native receipt certifies this typed command's exact provisional result.
                return prepared as SkillLibraryWorkerOperations[K]["output"];
              }
              throw error;
            } finally {
              // Revision publication precedes releasing the physical writer's FIFO.
              await publication;
            }
          },
          {
            assertCurrent,
            createAdmission(operation) {
              let stage: "transaction" | "commit" = "transaction";
              let settle: ReturnType<typeof fenceSkillLibraryMutationAuthority> | undefined;
              let granted = false;
              admission = createSqliteWorkerOperationAdmission((request, grant) => {
                assertCurrent();
                if (request.stage !== stage) {
                  throw new Error("Unexpected skill library write admission");
                }
                if (stage === "transaction") {
                  stage = "commit";
                } else {
                  stage = "transaction";
                  prepared = request.facts;
                  if (
                    type !== "skillLibrary.upload" &&
                    isRecord(request.facts) &&
                    request.facts.state !== "unchanged"
                  ) {
                    settle = fenceSkillLibraryMutationAuthority(context.admission);
                  }
                }
                const accepted = grant();
                if (request.stage === "commit") {
                  granted = accepted;
                }
              });
              const accepted = admission;
              publication = operation.settled.then((outcome) => {
                const committed =
                  accepted.committed && isDeepStrictEqual(accepted.committed.facts, prepared);
                settle?.(
                  committed
                    ? "committed"
                    : !granted || outcome.kind === "completed"
                      ? "rolled-back"
                      : "unknown",
                );
              });
              return { admission, nativeLocations: [pinned.path] };
            },
          },
        );
      } finally {
        await publication;
      }
    },
  };

  function captureSessionFacts() {
    const profile = input.profileId
      ? readResidentUserProfileIdentity(input.profileId, pinned)
      : undefined;
    if (input.profileId && !profile) {
      throw new SkillLibraryError(
        "AUTHORITY_EXPIRED",
        "Your Gateway profile is no longer available. Sign in again before accessing the library.",
      );
    }
    return {
      profile: profile
        ? { id: profile.profileId, role: profile.role, githubLogin: profile.githubLogin ?? null }
        : undefined,
      multipleProfiles: hasMultipleResidentSessionSharingIdentities(pinned),
    };
  }
}
