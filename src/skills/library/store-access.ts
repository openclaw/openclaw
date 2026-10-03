import { isDeepStrictEqual } from "node:util";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { captureUserProfileAuthorityRead } from "../../state/user-profile-events.js";
import { SkillLibraryError } from "./errors.js";
import type {
  SkillLibraryReadInput,
  SkillLibraryReadQueries,
  SkillLibraryWorkerAuthority,
} from "./read.contract.js";
import { captureSkillLibraryAuthorityRead } from "./store-authority.js";
import type { SkillLibraryAuthority } from "./store.js";

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
    profileId: authority.profileId,
    namespace: authority.namespace,
    scopes: [...authority.scopes],
    config: { gateway: { roles } },
  };
  const pinned = { path: context.admission.databasePath, env: { ...env, ...context.environment } };
  const assertCurrent = () => {
    context.admission.assertCurrent();
    authority.assertCurrent();
    if (
      !isDeepStrictEqual(roles, authority.getConfig().gateway?.roles) ||
      !isDeepStrictEqual(input.scopes, authority.scopes) ||
      input.profileId !== authority.profileId
    ) {
      throw new SkillLibraryError(
        "AUTHORITY_EXPIRED",
        "Skill library authority changed. Refresh and retry.",
      );
    }
  };
  return {
    options: pinned,
    assertCurrent,
    async read<K extends keyof SkillLibraryReadQueries>(
      kind: K,
      params: SkillLibraryReadQueries[K]["input"],
    ) {
      assertCurrent();
      const capturedParams = structuredClone(params);
      const library = captureSkillLibraryAuthorityRead(context.admission);
      const assertSource = () => {
        assertCurrent();
        library.assertCurrent();
      };
      const profiles = await captureUserProfileAuthorityRead(context.admission);
      assertSource();
      const commandInput = {
        kind,
        params: capturedParams,
        authority: input,
      } as SkillLibraryReadInput; // SAFETY: K binds the captured kind and parameters in SkillLibraryReadQueries.
      const reply = await executeExistingOpenClawStateRead(
        pinned,
        { type: "skillLibrary.read", input: commandInput },
        { context, current: true },
      );
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
      const profileCurrent = profiles.bind(reply.profileIds);
      if (!profileCurrent) {
        throw new SkillLibraryError(
          "CONFLICT",
          "Profile authority changed during library access. Retry.",
        );
      }
      const check = () => {
        assertSource();
        if (!profileCurrent()) {
          throw new SkillLibraryError(
            "AUTHORITY_EXPIRED",
            "Skill library profile authority changed. Refresh and retry.",
          );
        }
      };
      check();
      // SAFETY: The typed read registry binds output to kind, checked against K above.
      const value = reply.value as SkillLibraryReadQueries[K]["output"];
      return { value, assertCurrent: check };
    },
  };
}
