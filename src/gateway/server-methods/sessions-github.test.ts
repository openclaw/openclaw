import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/io.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getUserProfileDisplay } from "../../state/user-profile-list.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  GitHubPublicationRequesterUnavailableError,
  rejectGitHubPublicationSelection,
} from "../github-publication-failure.js";
import type { GitHubPublicationCoordinator } from "../github-publication.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { createOperatorWsClient } from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "../server/ws-connection/connect-operator-access.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import type * as SessionStore from "../session-utils-store-worker.js";
import { sessionsGitHubHandlers } from "./sessions-github.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  SessionMutationAuthorization,
} from "./types.js";

const mocks = vi.hoisted(() => ({
  caller: vi.fn(),
  loadSession: vi.fn<typeof SessionStore.loadGatewaySessionEntryReadOnlyInWorker>(),
  request: vi.fn<GitHubPublicationCoordinator["requestForSessionV2"]>(),
}));

vi.mock("../../agents/tools/gateway-caller-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/gateway-caller-context.js")>()),
  getGatewayToolCallerIdentity: mocks.caller,
}));
vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionStore>()),
  loadGatewaySessionEntryReadOnlyInWorker: mocks.loadSession,
}));

async function withRealSessions(config: OpenClawConfig, run: () => Promise<void>) {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      await state.writeConfig(config);
      await captureRuntimeConfigAsyncReader()();
      mocks.caller.mockReturnValue(undefined);
      const real = await vi.importActual<typeof SessionStore>("../session-utils-store-worker.js");
      mocks.loadSession.mockImplementation(real.loadGatewaySessionEntryReadOnlyInWorker);
      await run();
    },
  );
}

const expectedSystemRequester = {
  version: 2,
  signal: expect.any(AbortSignal),
  prepareSource: expect.any(Function),
  snapshot: { version: 1, actor: { kind: "system" }, scopes: ["operator.admin"], grant: null },
  assertCurrent: expect.any(Function),
  assertInvocationCurrent: expect.any(Function),
};
const acceptedPublication = {
  requestId: "publication-1",
  status: "requested",
  message: "Publication was accepted.",
} as const;
const callerSession = "agent:main:dashboard:task";
function expectPublication(overrides: Record<string, unknown> = {}) {
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith({
    sessionKey: callerSession,
    agentId: "main",
    expectedRunId: "run-1",
    requester: expectedSystemRequester,
    ...overrides,
  });
}

async function invoke(
  params: Record<string, unknown>,
  options: {
    client?: GatewayClient;
    registered?: boolean;
    sessionMutationAuthorization?: SessionMutationAuthorization;
  } = {},
) {
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  const request: GatewayRequestHandlerOptions = {
    params,
    respond,
    context: {
      githubPublicationService: { requestForSessionV2: mocks.request },
      getRuntimeConfig,
    } as never,
    client:
      options.client ??
      createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "system" },
        scopes: ["operator.admin"],
      }),
    req: { type: "req", id: "req-publication", method: "sessions.github.publish", params },
    isWebchatConnect: () => false,
    sessionMutationAuthorization: options.sessionMutationAuthorization,
  };
  const handler = options.registered
    ? handleGatewayRequest
    : expectDefined(
        sessionsGitHubHandlers["sessions.github.publish"],
        "sessions.github.publish handler",
      );
  await handler(request);
  return respond;
}

describe("sessions.github.publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfigSnapshot({});
    mocks.caller.mockReturnValue({
      agentId: "main",
      sessionKey: callerSession,
      operationalRunInstance: { runId: "run-1" },
    });
    mocks.loadSession.mockImplementation(async ({ cfg }) => {
      const canonicalKey = callerSession;
      const entry = { sessionId: "session-1", updatedAt: 1 };
      return {
        cfg,
        canonicalKey,
        agentId: "main",
        storePath: "/synthetic/sessions-github.sqlite",
        storeKeys: [canonicalKey],
        store: { [canonicalKey]: entry },
        entry,
        legacyKey: undefined,
      };
    });
    mocks.request.mockReset().mockImplementation(async ({ requester }) => {
      expect(() => requester.assertCurrent()).not.toThrow();
      return acceptedPublication;
    });
  });

  afterEach(clearRuntimeConfigSnapshot);

  it("uses host-owned caller identity", async () => {
    const respond = await invoke({ idempotencyKey: "tool-call-1", title: "Publish the fix" });

    expectPublication({
      idempotencyKey: "tool-call-1",
      title: "Publish the fix",
    });
    expect(respond).toHaveBeenCalledWith(true, acceptedPublication);
  });

  it.each([
    { agentId: "research" },
    { sessionKey: "agent:research:main" },
    { repository: "openclaw/openclaw", branch: "main", token: "secret" },
  ])("rejects caller-supplied authority %j", async (target) => {
    const respond = await invoke({ idempotencyKey: "conflicting-owner", ...target });

    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.loadSession).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it.each(["fresh", "wrong-key", "existing", "lookup-failed", "ordinary"])(
    "forwards only the exact owner's %s selection rejection fact",
    async (mode) => {
      const key = "publication-selection";
      mocks.request.mockImplementationOnce(() => {
        if (mode === "ordinary") {
          throw new Error("GitHub publication identity changed.");
        }
        rejectGitHubPublicationSelection("GitHub publication identity changed.", {
          idempotencyKey: mode === "wrong-key" ? "another-invocation" : key,
          hasRequest: () => {
            if (mode === "lookup-failed") {
              throw new Error("Receipt lookup unavailable.");
            }
            return mode === "existing";
          },
        });
      });
      const respond = await invoke({ idempotencyKey: key });
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "UNAVAILABLE",
        message: "GitHub publication identity changed.",
        ...(mode === "fresh"
          ? { details: { code: "GITHUB_PUBLICATION_SELECTION_REJECTED", idempotencyKey: key } }
          : {}),
      });
    },
  );

  it.each(["admitted", "unprepared"] as const)(
    "preserves %s operator authority through the registered publication handler",
    async (source) => {
      const config: OpenClawConfig = {
        gateway: {
          roles: {
            definitions: {
              staff: {
                scopes: ["operator.read", "operator.write"],
                agents: ["main"],
                sessions: { others: "write" },
              },
            },
            default: "staff",
          },
        },
      };
      await withRealSessions(config, async () => {
        const profile = await ensureCanonicalUserProfileForEmail("publisher@example.test");
        const creator = await ensureCanonicalUserProfileForEmail("session-creator@example.test");
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:main" },
          {
            sessionId: "session-main",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: creator.id },
          },
        );
        const client = createOperatorWsClient({ scopes: ["operator.write"] });
        client.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: profile.displayName,
          avatarRevision: getUserProfileDisplay(profile.id).avatarRevision,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        };
        if (source === "admitted") {
          prepareGatewayConnectOperatorAccess(client);
        }
        const respond = await invoke(
          { sessionKey: "main", idempotencyKey: "operator-publication-1" },
          { client, registered: true },
        );

        if (source === "unprepared") {
          expect(mocks.request).not.toHaveBeenCalled();
          expect(respond).toHaveBeenCalledWith(false, undefined, {
            code: "UNAVAILABLE",
            message: new GitHubPublicationRequesterUnavailableError().message,
          });
          return;
        }
        expect(mocks.request).toHaveBeenCalledExactlyOnceWith({
          sessionKey: "agent:main:main",
          idempotencyKey: "operator-publication-1",
          agentId: "main",
          requester: {
            ...expectedSystemRequester,
            snapshot: {
              ...expectedSystemRequester.snapshot,
              actor: { kind: "operator", profileId: profile.id },
              scopes: ["operator.write"],
            },
          },
        });
        expect(respond).toHaveBeenCalledWith(true, acceptedPublication);
      });
    },
  );

  it.each([
    ["global", "ops", "configured", undefined],
    ["agent:research:main", "research", "explicit", undefined],
    ["global", "research", "explicit", "research"],
  ])(
    "publishes %s from the actual %s store with %s ownership",
    async (sessionKey, expectedAgent, ownership, requestedAgentId) => {
      await withRealSessions(
        {
          session: { scope: "global" },
          agents: {
            ownership: "explicit",
            entries: { ops: {}, research: {} },
            ...(ownership === "configured"
              ? { defaults: { systemAgent: { agentId: "ops" } } }
              : {}),
          },
        },
        async () => {
          for (const agentId of ["ops", "research"]) {
            await upsertSessionEntryCore(
              { agentId, sessionKey: "global" },
              { sessionId: `global-${agentId}`, updatedAt: 1 },
            );
          }
          const respond = await invoke({
            sessionKey,
            idempotencyKey: "global-publication",
            ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ status: "requested" }),
          );
          expect(mocks.request).toHaveBeenCalledWith({
            sessionKey: "global",
            idempotencyKey: "global-publication",
            agentId: expectedAgent,
            requester: expectedSystemRequester,
          });
        },
      );
    },
  );

  it("rejects a publication whose session authorization changes while verification waits", async () => {
    const request = createDeferredCore<Awaited<ReturnType<typeof mocks.request>>>();
    const entered = createDeferredCore();
    mocks.request.mockImplementationOnce(() => {
      entered.resolve();
      return request.promise;
    });
    let authorized = true;
    const changed = new SessionMutationAuthorizationChangedError(
      errorShape(ErrorCodes.INVALID_REQUEST, "session participation changed"),
    );
    const authorization: SessionMutationAuthorization = {
      assertCurrent: () => {
        if (!authorized) {
          throw changed;
        }
      },
      assertTargetCurrent: vi.fn(),
    };

    const pending = invoke(
      { sessionKey: callerSession, idempotencyKey: "publication-revoked" },
      { sessionMutationAuthorization: authorization },
    );
    await entered.promise;
    const requester = expectDefined(mocks.request.mock.calls[0], "publication request")[0]
      .requester;
    expect(requester.snapshot).toEqual(expectedSystemRequester.snapshot);
    expect(() => requester.assertCurrent()).not.toThrow();
    authorized = false;
    expect(() => requester.assertCurrent()).toThrow(GitHubPublicationRequesterUnavailableError);
    request.resolve({ ...acceptedPublication, requestId: "publication-revoked" });

    await expect(pending).rejects.toBe(changed);
    expectPublication({ idempotencyKey: "publication-revoked", requester });
  });
});
