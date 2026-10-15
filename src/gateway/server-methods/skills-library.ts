import { isDeepStrictEqual } from "node:util";
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
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../../config/sessions/session-entry-current-check.js";
import {
  sessionEntryCommitGuardOptions,
  prepareSessionSourceAuthority,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
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
import { projectSkillLibraryList, type SkillLibraryAuthority } from "../../skills/library/store.js";
import { SkillLibraryError } from "../../skills/skill-library-error.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { captureSessionSharingMemoryFacts } from "../session-sharing-incognito.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import {
  captureSessionMutationRouting,
  prepareSessionMutationFacts,
} from "../session-sharing-preparation.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
} from "../session-sharing-read.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
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
    assertCurrent: composeSessionSourceAssertion(
      [
        assertFileMutationAllowed,
        options.sessionMutationCommitGuard,
        options.sessionMutationAuthorization?.assertCurrent,
      ],
      (assertSources) => {
        assertSources();
        // Synthetic agents must carry host-bound operator authority; identityless agents cannot publish.
        if (client?.internal?.syntheticClient) {
          throw new SkillLibraryError(
            "IDENTITY_REQUIRED",
            "Synthetic calls cannot acquire personal ownership. Ask the person to send a fresh attributed message or use My skills.",
          );
        }
      },
    ),
  };
}

export async function activateLibrarySelection(
  options: SkillLibraryRequestOwner,
  params: SkillsLibraryActivateParams,
) {
  const { client, context } = options;
  const resolvedAuthorization = await resolveSessionMutationAuthorizationAsync({
    client,
    context,
    method: "skills.library.activate",
    requestParams: params,
  });
  using authorization = {
    ...resolvedAuthorization,
    [Symbol.dispose]: () => resolvedAuthorization.authorization?.release?.(),
  };
  if (authorization.error) {
    throw new SessionMutationAuthorizationChangedError(authorization.error);
  }
  const selected = await selectedSession(options, params.sessionKey);
  try {
    const target = selected.target;
    const authority = libraryAuthority(options);
    let plannedSelections: SkillLibrarySelection[] | undefined;
    const sessionChanged = () =>
      new SkillLibraryError("CONFLICT", "Session changed before activation; refresh and retry.");
    const source = selected.source;
    const assertCurrent = composeSessionSourceAssertion(
      [authority.assertCurrent, authorization.authorization?.assertCurrent, source],
      (assertSources) => {
        assertSources();
        assertPreparedSkillLibrarySelection(plannedSelections);
      },
    );
    const entry = await patchSessionEntryCore(
      { storePath: target.storePath, sessionKey: target.storeKey, agentId: target.agentId },
      async (current) => {
        assertCurrent();
        plannedSelections = await changeSkillLibrarySelection(
          authority,
          current.skillLibrarySelections ?? [],
          params,
        );
        assertCurrent();
        // Existing runs keep their prepared snapshot; the next turn rebuilds against the new pins.
        return { skillLibrarySelections: plannedSelections, updatedAt: Date.now() };
      },
      sessionEntryCommitGuardOptions(assertCurrent),
    );
    if (!entry) {
      throw sessionChanged();
    }
    return {
      sessionKey: target.canonicalKey,
      selections: entry.skillLibrarySelections ?? [],
      sessionActivation: "next-turn" as const,
    };
  } finally {
    await selected.release();
  }
}

async function selectedSession(
  options: SkillLibraryRequestOwner,
  sessionKey: string,
): Promise<{
  target: SessionSharingTarget;
  source: SessionSourceAssertion;
  assertCurrent: () => void;
  release: () => void | Promise<void>;
}> {
  const sourceCfg = options.context.getRuntimeConfig();
  if (!isIncognitoSessionKey(sessionKey)) {
    const profiles = await prepareSessionSharingProfiles(options.client);
    const { agentId } = resolveSessionStoreIdentity({ cfg: sourceCfg, sessionKey });
    const facts = await prepareSessionMutationFacts({ cfg: sourceCfg, sessionKey, agentId });
    let entryRead:
      | Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>>
      | undefined;
    let pins: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
    let entryAuthority: Awaited<ReturnType<typeof prepareSessionSourceAuthority>> | undefined;
    const release = async () => {
      try {
        await entryAuthority?.release?.();
      } finally {
        pins?.release();
        entryRead?.release();
        facts.release();
      }
    };
    try {
      const identity = facts.readCurrent(sourceCfg).target;
      entryRead = await captureSessionEntryCurrentCheckAsyncInternal({
        agentId: identity.agentId,
        sessionKey: identity.storeKey,
        storePath: identity.readSource?.path ?? identity.storePath,
        fields: ["pluginOwnerId"],
        errorMessage: "Session selection changed; refresh and retry.",
      });
      entryAuthority = await prepareSessionSourceAuthority(entryRead.source);
      const entry = entryRead.entry;
      const readSource = identity.readSource;
      if (!entry || !readSource || typeof readSource.databaseIdentity !== "string") {
        throw new SkillLibraryError("NOT_FOUND", "Session not found.");
      }
      pins = retainPreparedSessionEntryPredicate({
        databaseIdentity: `file:${readSource.databaseIdentity}`,
        sessionKey: identity.storeKey,
        entry,
        matches: (_before, after) =>
          isDeepStrictEqual(entry.skillLibrarySelections, after?.skillLibrarySelections),
      });
      const currentTarget = () => {
        entryAuthority!.assertCurrent();
        const cfg = options.context.getRuntimeConfig();
        const current = facts.readCurrent(cfg);
        if (
          !current.target ||
          current.target.entry.sessionId !== entry.sessionId ||
          current.target.entry.lifecycleRevision !== entry.lifecycleRevision
        ) {
          throw new SkillLibraryError("CONFLICT", "Session selection changed; refresh and retry.");
        }
        const sharing = prepareProjectedSessionSharing({
          cfg,
          client: options.client,
          profiles,
          isMember: (_target, id) => current.membership.has(id),
        });
        const error = sharing.authorizeTarget(current.target);
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
        return { ...current.target, entry };
      };
      const target = currentTarget();
      const assertMutationCurrent = () => {
        const current = currentTarget();
        const error = resolvePluginSessionOwnershipError({
          action: "patch",
          entry: current.entry,
          key: current.canonicalKey,
          pluginOwnerId: options.client?.internal?.pluginRuntimeOwnerId,
        });
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
      };
      const source = composeSessionSourceAssertion([entryRead.source], (assertSources) => {
        assertSources();
        assertMutationCurrent();
      });
      return {
        target,
        source,
        assertCurrent() {
          currentTarget();
          if (!pins!.isCurrent()) {
            throw new SkillLibraryError(
              "CONFLICT",
              "Session selection changed; refresh and retry.",
            );
          }
        },
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
  const identity = resolveSessionStoreIdentity({ cfg: sourceCfg, sessionKey });
  const profiles = await prepareSessionSharingProfiles(options.client);
  let active = true;
  const actorFacts = captureSessionSharingMemoryFacts(
    {
      sessionKey: identity.canonicalKey,
      agentId: identity.agentId,
      resolved: {
        storePath: resolveSessionStorePathCore(sourceCfg.session?.store, {
          agentId: identity.agentId,
        }),
      },
    },
    () => {
      if (!active) {
        throw new SkillLibraryError("CONFLICT", "Session selection was released.");
      }
    },
  );
  if (!actorFacts) {
    throw new SkillLibraryError("NOT_FOUND", "Session not found.");
  }
  const assertRouting = captureSessionMutationRouting(sourceCfg);
  const resolve = (): SessionSharingTarget => {
    const cfg = options.context.getRuntimeConfig();
    assertRouting(cfg);
    const { target, membership } = actorFacts.readCurrent();
    if (!target) {
      throw new SkillLibraryError("NOT_FOUND", "Session not found.");
    }
    const sharing = prepareProjectedSessionSharing({
      cfg,
      client: options.client,
      profiles,
      isMember: (_target, id) => membership.has(id),
    });
    const error = sharing.authorizeTarget(target);
    if (error) {
      throw new SessionMutationAuthorizationChangedError(error);
    }
    return target;
  };
  const target = resolve();
  try {
    const currentTarget = () => {
      const current = resolve();
      if (
        current.entry.sessionId !== target.entry.sessionId ||
        current.entry.lifecycleRevision !== target.entry.lifecycleRevision ||
        current.entry.pluginOwnerId !== target.entry.pluginOwnerId
      ) {
        throw new SkillLibraryError("CONFLICT", "Session selection changed; refresh and retry.");
      }
      return current;
    };
    const assertCurrent = () => {
      const current = currentTarget();
      if (
        JSON.stringify(current.entry.skillLibrarySelections) !==
        JSON.stringify(target.entry.skillLibrarySelections)
      ) {
        throw new SkillLibraryError("CONFLICT", "Session selection changed; refresh and retry.");
      }
    };
    const assertMutationCurrent = () => {
      const current = currentTarget();
      const error = resolvePluginSessionOwnershipError({
        action: "patch",
        entry: current.entry,
        key: current.canonicalKey,
        pluginOwnerId: options.client?.internal?.pluginRuntimeOwnerId,
      });
      if (error) {
        throw new SessionMutationAuthorizationChangedError(error);
      }
    };
    assertCurrent();
    const source: SessionSourceAssertion = Object.assign(assertMutationCurrent, {
      async prepareSessionSource() {
        assertMutationCurrent();
        return { assertCurrent: assertMutationCurrent, checks: [] };
      },
    });
    return {
      target,
      assertCurrent,
      source,
      release: () => {
        active = false;
      },
    };
  } catch (error) {
    active = false;
    throw error;
  }
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
      const session = params.sessionKey
        ? await selectedSession(options, params.sessionKey)
        : undefined;
      try {
        const access = captureSkillLibraryAccess(authority);
        const listed = await access.read("list", {});
        const result = projectSkillLibraryList(listed.value, params);
        if (session) {
          const pins = session.target.entry.skillLibrarySelections ?? [];
          const selected = await access.read("pins", pins);
          listed.assertCurrent();
          selected.assertCurrent();
          session.assertCurrent();
          result.session = {
            sessionKey: session.target.canonicalKey,
            selections: selected.value,
            attachable: listed.value.entries.filter(
              (entry) => !pins.some((pin) => pin.skillId === entry.skillId),
            ),
          };
        }
        return result;
      } finally {
        await session?.release();
      }
    },
  ),
  "skills.library.read": libraryHandler(
    "skills.library.read",
    validateSkillsLibraryReadParams,
    async (authority, params, options) => {
      if (!params.sessionKey) {
        return readSkillLibrary(authority, params.skillId, params.revision);
      }
      const session = await selectedSession(options, params.sessionKey);
      try {
        const pin = session.target.entry.skillLibrarySelections?.find(
          (selection) =>
            selection.skillId === params.skillId && selection.revision === params.revision,
        );
        if (!pin) {
          session.assertCurrent();
          throw new SkillLibraryError(
            "FORBIDDEN",
            "Session reads require an exact selected skillId and revision.",
          );
        }
        return await readSkillLibrary(
          authority,
          params.skillId,
          params.revision,
          {},
          { revision: pin.revision, assertSessionAccess: session.assertCurrent },
        );
      } finally {
        await session.release();
      }
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
