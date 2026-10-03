import {
  ErrorCodes,
  errorShape,
  type ProtocolValidator,
  validateSkillsLibraryListParams,
  validateSkillsLibraryReadParams,
  validateSkillsLibrarySaveParams,
  validateSkillsLibraryMutateParams,
  validateSkillsLibraryActivateParams,
  validateSkillsLibraryImportParams,
  validateSkillsLibraryUploadParams,
  type SkillsLibraryActivateParams,
  type SkillLibrarySelection,
} from "../../../packages/gateway-protocol/src/index.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { importSkillLibrary, uploadSkillLibrary } from "../../skills/library/import.js";
import {
  assertPreparedSkillLibrarySelection,
  changeSkillLibrarySelection,
} from "../../skills/library/selection.js";
import {
  readSkillLibrary,
  saveSkillLibrary,
  mutateSkillLibrary,
} from "../../skills/library/service.js";
import { captureSkillLibraryAccess } from "../../skills/library/store-access.js";
import type { SkillLibraryAuthority } from "../../skills/library/store.js";
import { SkillLibraryError } from "../../skills/skill-library-error.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import {
  authorizeSessionSharingTarget,
  resolveSessionMutationAuthorization,
  resolveSessionSharingTarget,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export type SkillLibraryRequestOwner = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "sessionMutationCommitGuard" | "sessionMutationAuthorization"
>;

export function libraryAuthority(
  options: SkillLibraryRequestOwner,
  assertFileMutationAllowed?: () => void,
): SkillLibraryAuthority {
  const { client, context } = options;
  return {
    profileId: client?.authenticatedUserProfile?.profileId,
    scopes: client?.connect.scopes ?? [],
    getConfig: context.getRuntimeConfig,
    assertFileMutationAllowed,
    assertCurrent: () => {
      assertFileMutationAllowed?.();
      options.sessionMutationCommitGuard?.();
      options.sessionMutationAuthorization?.assertCurrent();
      // Synthetic agents must carry host-bound operator authority; identityless agents cannot publish.
      if (client?.internal?.syntheticClient) {
        throw new SkillLibraryError(
          "IDENTITY_REQUIRED",
          "Synthetic calls cannot acquire personal ownership. Ask the person to send a fresh attributed message or use My skills.",
        );
      }
    },
  };
}

export async function activateLibrarySelection(
  options: SkillLibraryRequestOwner,
  params: SkillsLibraryActivateParams,
) {
  const { client, context } = options;
  const authorization = resolveSessionMutationAuthorization({
    client,
    context,
    method: "skills.library.activate",
    requestParams: params,
  });
  if (authorization.error) {
    throw new SessionMutationAuthorizationChangedError(authorization.error);
  }
  const target = resolveSessionSharingTarget({
    cfg: context.getRuntimeConfig(),
    sessionKey: params.sessionKey,
  });
  if (!target) {
    throw new SkillLibraryError("NOT_FOUND", "Session not found.");
  }
  const authority = libraryAuthority(options);
  let plannedSelections: SkillLibrarySelection[] | undefined;
  const assertCurrent = () => {
    authority.assertCurrent();
    authorization.authorization?.assertCurrent();
    assertPreparedSkillLibrarySelection(plannedSelections);
    const current = resolveSessionSharingTarget({
      cfg: context.getRuntimeConfig(),
      sessionKey: params.sessionKey,
    });
    if (
      !current ||
      current.entry.sessionId !== target.entry.sessionId ||
      current.entry.lifecycleRevision !== target.entry.lifecycleRevision ||
      current.storePath !== target.storePath ||
      current.storeKey !== target.storeKey
    ) {
      throw new SkillLibraryError(
        "CONFLICT",
        "Session changed before activation; refresh and retry.",
      );
    }
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "patch",
      entry: current.entry,
      key: current.canonicalKey,
      pluginOwnerId: client?.internal?.pluginRuntimeOwnerId,
    });
    if (ownershipError) {
      throw new SessionMutationAuthorizationChangedError(ownershipError);
    }
  };
  const entry = await patchSessionEntryCore(
    { storePath: target.storePath, sessionKey: target.storeKey, agentId: target.agentId },
    async (current) => {
      assertCurrent();
      const selections = await changeSkillLibrarySelection(
        authority,
        current.skillLibrarySelections ?? [],
        params,
      );
      plannedSelections = selections;
      assertCurrent();
      // Existing runs keep their prepared snapshot; the next turn rebuilds against the new pins.
      return { skillLibrarySelections: selections, updatedAt: Date.now() };
    },
    { assertCommitAllowed: assertCurrent },
  );
  if (!entry) {
    throw new SkillLibraryError(
      "CONFLICT",
      "Session changed before activation; refresh and retry.",
    );
  }
  return {
    sessionKey: target.canonicalKey,
    selections: entry.skillLibrarySelections ?? [],
    sessionActivation: "next-turn" as const,
  };
}

function selectedSession(options: SkillLibraryRequestOwner, sessionKey: string) {
  const resolve = () => {
    const cfg = options.context.getRuntimeConfig();
    const target = resolveSessionSharingTarget({ cfg, sessionKey });
    if (!target) {
      throw new SkillLibraryError("NOT_FOUND", "Session not found.");
    }
    const error = authorizeSessionSharingTarget({ cfg, client: options.client, target });
    if (error) {
      throw new SessionMutationAuthorizationChangedError(error);
    }
    return target;
  };
  const target = resolve();
  return {
    target,
    assertCurrent: () => {
      const current = resolve();
      if (
        current.entry.sessionId !== target.entry.sessionId ||
        current.entry.lifecycleRevision !== target.entry.lifecycleRevision ||
        JSON.stringify(current.entry.skillLibrarySelections) !==
          JSON.stringify(target.entry.skillLibrarySelections)
      ) {
        throw new SkillLibraryError("CONFLICT", "Session selection changed; refresh and retry.");
      }
    },
  };
}

function libraryHandler<P extends Record<string, unknown>>(
  name: string,
  validate: ProtocolValidator<P>,
  run: (
    authority: SkillLibraryAuthority,
    params: P,
    options: GatewayRequestHandlerOptions,
  ) => unknown,
): GatewayRequestHandlers[string] {
  return defineValidatedGatewayHandler(
    name,
    validate,
    async (options) => {
      options.respond(
        true,
        await run(
          libraryAuthority(
            options,
            captureGatewayClientUploadCommitGuard({
              method: name,
              requestParams: options.params,
              client: options.client,
              context: options.context,
            }),
          ),
          options.params,
          options,
        ),
        undefined,
      );
    },
    (error) => {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        return error.error;
      }
      return error instanceof SkillLibraryError
        ? errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
            details: {
              code: `SKILL_LIBRARY_${error.code}`,
              ...(error.currentRevision ? { currentRevision: error.currentRevision } : {}),
            },
          })
        : errorShape(
            ErrorCodes.UNAVAILABLE,
            "Unable to complete the skill library operation. Review the bundle or retry the request.",
          );
    },
  );
}

export const skillsLibraryHandlers: GatewayRequestHandlers = {
  "skills.library.list": libraryHandler(
    "skills.library.list",
    validateSkillsLibraryListParams,
    async (authority, params, options) => {
      const session = params.sessionKey ? selectedSession(options, params.sessionKey) : undefined;
      const access = captureSkillLibraryAccess(authority);
      const listed = await access.read("list", params);
      const result = listed.value;
      if (session) {
        const pins = session.target.entry.skillLibrarySelections ?? [];
        const selected = await access.read("pins", pins);
        const all = params.scope ? await access.read("list", {}) : listed;
        listed.assertCurrent();
        selected.assertCurrent();
        all.assertCurrent();
        session.assertCurrent();
        result.session = {
          sessionKey: session.target.canonicalKey,
          selections: selected.value,
          attachable: all.value.entries.filter(
            (entry) => !pins.some((pin) => pin.skillId === entry.skillId),
          ),
        };
      }
      return result;
    },
  ),
  "skills.library.read": libraryHandler(
    "skills.library.read",
    validateSkillsLibraryReadParams,
    (authority, params, options) => {
      if (!params.sessionKey) {
        return readSkillLibrary(authority, params.skillId, params.revision);
      }
      const session = selectedSession(options, params.sessionKey);
      const pin = session.target.entry.skillLibrarySelections?.find(
        (selection) =>
          selection.skillId === params.skillId && selection.revision === params.revision,
      );
      if (!pin) {
        throw new SkillLibraryError(
          "FORBIDDEN",
          "Session reads require an exact selected skillId and revision.",
        );
      }
      return readSkillLibrary(
        authority,
        params.skillId,
        params.revision,
        {},
        { revision: pin.revision, assertSessionAccess: session.assertCurrent },
      );
    },
  ),
  "skills.library.save": libraryHandler(
    "skills.library.save",
    validateSkillsLibrarySaveParams,
    async (authority, { retainFiles, ...params }) => {
      if (!retainFiles?.length) {
        return saveSkillLibrary(authority, params);
      }
      if (!params.skillId || !params.expectedRevision) {
        throw new SkillLibraryError(
          "INVALID_BUNDLE",
          "Retaining skill files requires skillId and expectedRevision.",
        );
      }
      const existing = await readSkillLibrary(authority, params.skillId, params.expectedRevision);
      const filesByPath = new Map(existing.files.map((file) => [file.path, file]));
      const retained = retainFiles.map((path) => {
        const file = filesByPath.get(path);
        if (!file) {
          throw new SkillLibraryError(
            "INVALID_BUNDLE",
            "Retained skill files must name distinct support files in expectedRevision.",
          );
        }
        filesByPath.delete(path);
        return file;
      });
      // The save owner rechecks write authority, CAS, and the complete merged bundle.
      return saveSkillLibrary(authority, {
        ...params,
        files: [...retained, ...(params.files ?? [])],
      });
    },
  ),
  "skills.library.mutate": libraryHandler(
    "skills.library.mutate",
    validateSkillsLibraryMutateParams,
    (authority, params) => mutateSkillLibrary(authority, params),
  ),
  "skills.library.activate": libraryHandler(
    "skills.library.activate",
    validateSkillsLibraryActivateParams,
    (_authority, params, options) => activateLibrarySelection(options, params),
  ),
  "skills.library.import": libraryHandler(
    "skills.library.import",
    validateSkillsLibraryImportParams,
    (authority, params) => importSkillLibrary(authority, params),
  ),
  "skills.library.upload": libraryHandler(
    "skills.library.upload",
    validateSkillsLibraryUploadParams,
    (authority, params) => uploadSkillLibrary(authority, params),
  ),
};
