import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { addSessionMember } from "../../../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import * as voiceSources from "../../../talk/client-voice-session-source.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { makeClient } from "../../server-broadcast.test-helpers.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import type {
  GatewayRequestHandlerOptions,
  SessionMutationAuthorization,
} from "../../server-methods/types.js";
import { roleClient, rolePolicyConfig } from "../../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { authorizeBrowserCreate, browserAuthority } from "./client-create-ensure.test-support.js";
import { createTalkClient } from "./client-create.js";
import {
  browserSession,
  createDelegatedBrowserProviderFixture,
} from "./client-fixtures.test-support.js";

const voiceMocks = vi.hoisted(() => ({ resolveConfiguredRealtimeVoiceProviderAsync: vi.fn() }));
vi.mock("../../../talk/provider-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-resolver.js")>()),
  resolveConfiguredRealtimeVoiceProviderAsync:
    voiceMocks.resolveConfiguredRealtimeVoiceProviderAsync,
}));

describe("cross-store voice creation authority", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["membership", "before"],
    ["membership", "after"],
    ["session", "before"],
    ["session", "after"],
  ] as const)("honors %s revocation %s cross-store voice admission", async (revocation, timing) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async ({ stateDir }) => {
        const sessionKey = "agent:main:main";
        const sessionId = "voice-transcript-session";
        setRuntimeConfigSnapshot({});
        const seedEntry = { sessionId, updatedAt: Date.now() };
        await applySessionEntryOperation(
          { agentId: "main", sessionKey },
          { kind: "fields", patch: seedEntry },
          { fallbackEntry: seedEntry, replaceEntry: true, skipMaintenance: true },
        );
        const fixture = createDelegatedBrowserProviderFixture(async () => browserSession, stateDir);
        voiceMocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
          provider: fixture.provider,
          providerConfig: {},
          capabilities: fixture.provider.capabilities,
        });
        let authorization: SessionMutationAuthorization | undefined;
        let persistedId: string | undefined;
        try {
          const storePath = path.join(stateDir, "custom.sqlite");
          const config = {
            ...rolePolicyConfig(),
            ...fixture.context.getRuntimeConfig(),
            session: { store: storePath },
          } satisfies OpenClawConfig;
          fixture.context.getRuntimeConfig = () => config;
          setRuntimeConfigSnapshot(config);
          const role = roleClient("view", `voice-${revocation}`);
          const client = {
            ...makeClient(fixture.client.connId, "operator", ["operator.read", "operator.write"])
              .client,
            ...role,
            authenticatedUserProfile: { ...role.authenticatedUserProfile!, avatarRevision: "" },
          };
          const identityId = client.authenticatedUserProfile!.profileId;
          const scope = { agentId: "main", sessionKey, storePath };
          const entry = {
            sessionId,
            updatedAt: 1,
            visibility: "read-only" as const,
            createdActor: { type: "human", source: "profile", id: "other-creator" } as const,
          };
          await replaceSessionEntry(scope, entry);
          await addSessionMember(scope, { identityId, addedBy: "other-creator" });
          using authority = browserAuthority(fixture.context, client);
          const voiceSessionId = `admitted-${revocation}`;
          const respond = vi.fn();
          const options: GatewayRequestHandlerOptions = {
            req: { type: "req", id: "admitted-voice", method: "talk.client.create" },
            params: { sessionKey, voiceSessionId },
            respond,
            context: createDirectChatContext({
              getRuntimeConfig: fixture.context.getRuntimeConfig,
              getClientConnIds: (filter) =>
                new Set(!filter || filter(client) ? [client.connId] : []),
              broadcastToConnIds: fixture.context.broadcastToConnIds,
            }),
            client,
            isWebchatConnect: () => false,
          };
          authority.bind(options);
          const admission = await authorizeBrowserCreate(options, true);
          expect(admission.error).toBeNull();
          authorization = admission.authorization!;
          let creating = false;
          let revoked = false;
          const revoke = () => {
            if (revoked) {
              return;
            }
            revoked = true;
            if (revocation === "membership") {
              expect(removeSessionMemberSync(scope, identityId)).toMatchObject({ identityId });
            } else {
              replaceSessionEntrySync(scope, {
                ...entry,
                sessionId: "successor",
                updatedAt: 2,
              });
            }
          };
          const prepareSources = voiceSources.prepareClientVoiceSessionSourceChecks;
          vi.spyOn(voiceSources, "prepareClientVoiceSessionSourceChecks").mockImplementation(
            (...args) => {
              if (creating && timing === "before") {
                revoke();
              }
              return prepareSources(...args);
            },
          );
          const create = voiceSessions.createOrResumeClientVoiceSession;
          vi.spyOn(voiceSessions, "createOrResumeClientVoiceSession").mockImplementation(
            async (...args) => {
              creating = true;
              try {
                persistedId = await create(...args);
                return persistedId;
              } finally {
                creating = false;
              }
            },
          );
          const admitOperation = operationAdmission.createSqliteWorkerOperationAdmission;
          vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
            (admit, attachment) =>
              admitOperation((request, grant) => {
                if (creating && timing === "after" && request.stage === "commit") {
                  revoke();
                }
                admit(request, grant);
              }, attachment),
          );
          await createTalkClient(admission.handler);
          expect(revoked).toBe(true);
          const committed = timing === "after";
          expect({
            persistedId,
            recorded: clientVoiceSessionTesting.readRecord("main", voiceSessionId) !== undefined,
            ok: respond.mock.lastCall?.[0],
          }).toEqual({
            persistedId: committed ? voiceSessionId : undefined,
            recorded: committed,
            ok: false,
          });
          expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
          expect(() => authorization?.assertCurrent()).toThrow();
        } finally {
          authorization?.release?.();
          if (persistedId) {
            await closeTalkClientGatewayControlSession({
              voiceSessionId: persistedId,
              sessionKey,
              connId: fixture.client.connId,
            });
          }
          cleanupTalkConnection(fixture.client.connId, fixture.context.logGateway);
          clientVoiceSessionTesting.reset();
        }
      },
    );
  });
});
