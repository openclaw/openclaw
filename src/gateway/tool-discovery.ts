import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  composeSessionSourceAssertion,
  sessionEntryCommitGuardOptions,
  type SessionSourcePredicate,
} from "../config/sessions/session-source-authority.js";
import {
  SESSION_TOOL_DISCOVERY_SESSION_ID_MAX_LENGTH,
  type SessionToolDiscovery,
  type SessionToolDiscoveryCapture,
  type SessionToolDiscoveryPresentation,
} from "../config/sessions/tool-discovery.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import {
  captureResidentUserProfileAccess,
  readResidentUserProfileId,
} from "../state/user-profile-list.js";
import {
  isDirectGatewayUserClient,
  resolveGatewayAutomationDiscovery,
} from "./server-methods/cron-creator-authority-admission.js";
import {
  libraryAuthority,
  type SkillLibraryRequestOwner,
} from "./server-methods/skills-library.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import type { ExistingSessionMutationFacts } from "./session-sharing-target.types.js";

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Current profile/config facts invalidate presentation without reconstructing a connection's scopes. */
function profileFactsKey(profileId: string, config: OpenClawConfig): string | undefined {
  if (!readResidentUserProfileId(profileId)) {
    return undefined;
  }
  return fingerprint({
    profile: captureResidentUserProfileAccess(profileId).readCurrentFacts(),
    roles: config.gateway?.roles ?? null,
  });
}

/** Called only by ordinary Gateway ingress, after its real authoring preparation. */
export function captureGatewayToolDiscovery(
  owner: SkillLibraryRequestOwner,
  isHumanTurn: boolean,
  authoring: SkillLibraryAuthoringCapability | undefined,
): SessionToolDiscoveryCapture | undefined {
  const client = owner.client;
  if (!isHumanTurn) {
    return undefined;
  }
  const directUser = isDirectGatewayUserClient(client);
  const automations = resolveGatewayAutomationDiscovery(client);
  const authority = directUser ? libraryAuthority(owner) : undefined;
  const profileId = client?.authenticatedUserProfile?.profileId;
  const scopes = [...(client?.connect.scopes ?? [])];
  const assertCurrent = composeSessionSourceAssertion(
    [
      owner.sessionMutationCommitGuard,
      owner.sessionMutationAuthorization?.assertCurrent,
      authority?.assertCurrent,
    ],
    (assertSources) => {
      assertSources();
      if (
        owner.client !== client ||
        isDirectGatewayUserClient(client) !== directUser ||
        resolveGatewayAutomationDiscovery(client) !== automations ||
        client?.authenticatedUserProfile?.profileId !== profileId ||
        !isDeepStrictEqual(client?.connect.scopes ?? [], scopes)
      ) {
        throw new Error("Tool discovery requester changed before session preparation");
      }
    },
  );
  assertCurrent();
  const factsKey =
    directUser && profileId
      ? profileFactsKey(profileId, owner.context.getRuntimeConfig())
      : undefined;
  if (!profileId || !factsKey) {
    return { kind: "clear", assertCurrent };
  }
  return {
    kind: "profile",
    profileId,
    profileFactsKey: factsKey,
    presentation: {
      ...(authoring
        ? {
            workshop: {
              defaultTarget: authoring.defaultTarget,
              multipleProfiles: authoring.multipleProfiles,
            },
          }
        : {}),
      automations,
    },
    assertCurrent,
  };
}

function audienceKey(facts: ExistingSessionMutationFacts, config: OpenClawConfig): string {
  const { target, membership } = facts;
  const { entry } = target;
  return fingerprint({
    agentId: target.agentId,
    storePath: path.resolve(target.storePath),
    sessionKey: target.canonicalKey,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    createdActor: entry.createdActor,
    owner: entry.owner,
    visibility: entry.visibility ?? "shared",
    membership: [...membership].toSorted(),
    sharing: config.session?.sharing ?? null,
  });
}

export type PreparedSessionToolDiscovery = {
  presentation?: SessionToolDiscoveryPresentation;
  /** Fences preparation only; presentation staleness never aborts admitted execution. */
  assertCurrent: () => void;
  /** Ends the preparation fence once the tool surface and prompt are fixed. */
  completePreparation: () => void;
  [Symbol.dispose]: () => void;
};

const noDiscovery = (): PreparedSessionToolDiscovery => ({
  assertCurrent() {},
  completePreparation() {},
  [Symbol.dispose]() {},
});

/** Reuses the session owner and its committed audience publication through tool preparation. */
export async function prepareSessionToolDiscovery(params: {
  sessionKey?: string;
  sessionId: string;
  agentId?: string;
  storePath?: string;
  getConfig: () => OpenClawConfig;
  capture?: SessionToolDiscoveryCapture;
  assertCurrent: () => void;
}): Promise<PreparedSessionToolDiscovery> {
  if (
    !params.sessionKey ||
    !params.agentId ||
    !params.sessionId ||
    params.sessionId.length > SESSION_TOOL_DISCOVERY_SESSION_ID_MAX_LENGTH
  ) {
    return noDiscovery();
  }
  params.assertCurrent();
  const read = await prepareSessionMutationFacts({
    cfg: params.getConfig(),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    allowMissing: true,
  });
  try {
    params.assertCurrent();
    params.capture?.assertCurrent();
    const initial = read.readCurrent(params.getConfig());
    const target = initial.target;
    if (
      !target ||
      target.entry.sessionId !== params.sessionId ||
      (params.storePath && path.resolve(target.storePath) !== path.resolve(params.storePath))
    ) {
      read.release();
      return noDiscovery();
    }
    const expectedAudience = audienceKey({ ...initial, target }, params.getConfig());
    let saved = target.entry.toolDiscovery;
    let saving = false;
    const capture = params.capture;
    const assertCurrent = () => {
      params.assertCurrent();
      const current = read.readCurrent(params.getConfig());
      if (
        !current.target ||
        current.target.entry.sessionId !== params.sessionId ||
        (!saving && !isDeepStrictEqual(current.target.entry.toolDiscovery, saved)) ||
        audienceKey({ ...current, target: current.target }, params.getConfig()) !==
          expectedAudience ||
        (saved && profileFactsKey(saved.profileId, params.getConfig()) !== saved.profileFactsKey)
      ) {
        throw new Error("Tool discovery audience changed during preparation");
      }
    };
    if (capture) {
      // Retries reuse the ingress capture; outdated requester facts clear rather than abort.
      const next: SessionToolDiscovery | undefined =
        capture.kind === "profile" &&
        profileFactsKey(capture.profileId, params.getConfig()) === capture.profileFactsKey
          ? {
              version: 1,
              sessionId: params.sessionId,
              profileId: capture.profileId,
              profileFactsKey: capture.profileFactsKey,
              audienceKey: expectedAudience,
              presentation: capture.presentation,
            }
          : undefined;
      saved = next;
      saving = true;
      const assertCaptureCurrent = composeSessionSourceAssertion(
        [capture.assertCurrent, params.assertCurrent],
        (assertSources) => {
          assertSources();
          assertCurrent();
        },
      );
      assertCaptureCurrent();
      if (!isDeepStrictEqual(target.entry.toolDiscovery, next)) {
        // The existing retained reader supplies the exact audience predicate to its writer.
        const audienceSource = Object.assign(assertCurrent, {
          async prepareSessionSource() {
            await read.prepareRead();
            assertCaptureCurrent();
            const predicate: SessionSourcePredicate | undefined = target.readSource
              ? {
                  source: target.readSource,
                  sessionKey: target.storeKey,
                  fields: [
                    "sessionId",
                    "lifecycleRevision",
                    "createdActor",
                    "owner",
                    "visibility",
                    "toolDiscovery",
                  ],
                  expected: target.entry,
                  members: [...initial.membership],
                }
              : undefined;
            return {
              assertCurrent,
              checks: predicate
                ? [
                    {
                      predicate,
                      refuse: () => {
                        throw new Error("Tool discovery audience changed before commit");
                      },
                    },
                  ]
                : [],
            };
          },
        });
        await patchSessionEntryCore(
          { agentId: target.agentId, storePath: target.storePath, sessionKey: target.storeKey },
          (entry) => {
            assertCaptureCurrent();
            if (entry.sessionId !== params.sessionId) {
              throw new Error("Tool discovery session changed before commit");
            }
            return { toolDiscovery: next, updatedAt: Date.now() };
          },
          sessionEntryCommitGuardOptions(
            composeSessionSourceAssertion([assertCaptureCurrent, audienceSource]),
          ),
        );
        assertCaptureCurrent();
      }
      saving = false;
    }
    if (
      !saved ||
      saved.version !== 1 ||
      saved.sessionId !== params.sessionId ||
      saved.audienceKey !== expectedAudience ||
      profileFactsKey(saved.profileId, params.getConfig()) !== saved.profileFactsKey
    ) {
      read.release();
      return noDiscovery();
    }
    assertCurrent();
    let preparing = true;
    return {
      presentation: saved.presentation,
      assertCurrent: () => {
        if (preparing) {
          assertCurrent();
        }
      },
      completePreparation: () => {
        preparing = false;
      },
      [Symbol.dispose]: read.release,
    };
  } catch (error) {
    read.release();
    throw error;
  }
}
