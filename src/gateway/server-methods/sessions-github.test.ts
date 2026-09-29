import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import { getUserProfileDisplay } from "../../state/user-profiles.js";
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
import { loadGatewaySessionEntryReadOnly } from "../session-utils-store.js";
import { sessionsGitHubHandlers } from "./sessions-github.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  SessionMutationAuthorization,
} from "./types.js";

const mocks = vi.hoisted(() => ({
  caller: vi.fn(),
  loadSession: vi.fn(),
  request: vi.fn<GitHubPublicationCoordinator["requestForSession"]>(),
}));

vi.mock("../../agents/tools/gateway-caller-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/gateway-caller-context.js")>()),
  getGatewayToolCallerIdentity: mocks.caller,
}));
vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnly: mocks.loadSession,
}));

const expectedSystemRequester = {
  snapshot: {
    version: 1,
    actor: { kind: "system" },
    scopes: ["operator.admin"],
    grant: null,
  },
  assertCurrent: expect.any(Function),
  assertInvocationCurrent: expect.any(Function),
};

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
      githubPublicationService: { requestForSession: mocks.request },
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
    ...(options.sessionMutationAuthorization
      ? { sessionMutationAuthorization: options.sessionMutationAuthorization }
      : {}),
  };
  if (options.registered) {
    await handleGatewayRequest(request);
  } else {
    await expectDefined(
      sessionsGitHubHandlers["sessions.github.publish"],
      "sessions.github.publish handler",
    )(request);
  }
  return respond;
}

describe("sessions.github.publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.caller.mockReturnValue({
      agentId: "main",
      sessionKey: "agent:main:dashboard:task",
      operationalRunInstance: { runId: "run-1" },
    });
    mocks.loadSession.mockReturnValue({
      canonicalKey: "agent:main:dashboard:task",
      agentId: "main",
      entry: { sessionId: "session-1" },
    });
    mocks.request.mockImplementation(async ({ requester }) => {
      expect(() => requester.assertCurrent()).not.toThrow();
      return {
        requestId: "publication-1",
        status: "requested",
        message: "Publication was accepted.",
      };
    });
  });

  it.each([undefined, "main"])(
    "uses host-owned caller identity with requested owner %s",
    async (agentId) => {
      const respond = await invoke({
        idempotencyKey: "tool-call-1",
        title: "Publish the fix",
        ...(agentId ? { agentId } : {}),
      });

      expect(mocks.request).toHaveBeenCalledWith({
        idempotencyKey: "tool-call-1",
        title: "Publish the fix",
        sessionKey: "agent:main:dashboard:task",
        agentId: "main",
        expectedRunId: "run-1",
        requester: expectedSystemRequester,
      });
      expect(respond).toHaveBeenCalledWith(true, {
        requestId: "publication-1",
        status: "requested",
        message: "Publication was accepted.",
      });
    },
  );

  it.each([{ agentId: "research" }, { sessionKey: "agent:research:main" }])(
    "rejects a conflicting tool caller target %j",
    async (target) => {
      const respond = await invoke({ idempotencyKey: "conflicting-owner", ...target });

      expect(mocks.request).not.toHaveBeenCalled();
      expect(mocks.loadSession).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    },
  );

  it.each(["fresh", "existing", "wrong-key", "lookup-failed", "ordinary"])(
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

  it("rejects caller-supplied repository authority at the protocol boundary", async () => {
    const respond = await invoke({
      idempotencyKey: "tool-call-1",
      repository: "openclaw/openclaw",
      branch: "main",
      token: "secret",
    });

    expect(mocks.request).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it.each(["admitted", "unprepared"] as const)(
    "preserves %s operator authority through the registered publication handler",
    async (source) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
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
        });
        const profile = await ensureCanonicalUserProfileForEmail("publisher@example.test");
        const creator = await ensureCanonicalUserProfileForEmail("session-creator@example.test");
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:main" },
          {
            sessionId: "session-main",
            updatedAt: 1,
            ...buildSessionCreationStamp({
              via: "operator",
              actor: { type: "human", source: "profile", id: creator.id },
            }),
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
        mocks.caller.mockReturnValue(undefined);
        mocks.loadSession.mockImplementation(loadGatewaySessionEntryReadOnly);

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
            snapshot: {
              version: 1,
              actor: { kind: "operator", profileId: profile.id },
              scopes: ["operator.write"],
              grant: null,
            },
            assertCurrent: expect.any(Function),
            assertInvocationCurrent: expect.any(Function),
          },
        });
        expect(respond).toHaveBeenCalledWith(true, {
          requestId: "publication-1",
          status: "requested",
          message: "Publication was accepted.",
        });
      });
    },
  );

  it.each([
    ["agent:research:main", "research", "legacy", undefined],
    ["global", "ops", "legacy", undefined],
    ["agent:research:main", "research", "explicit", undefined],
    ["global", "research", "explicit", "research"],
  ])(
    "publishes %s from the actual %s store with %s ownership",
    async (sessionKey, expectedAgent, ownership, requestedAgentId) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          session: { scope: "global" },
          agents:
            ownership === "legacy"
              ? { entries: { ops: { default: true }, research: {} } }
              : { ownership: "explicit", entries: { ops: {}, research: {} } },
        });
        for (const agentId of ["ops", "research"]) {
          await upsertSessionEntryCore(
            { agentId, sessionKey: "global" },
            { sessionId: `global-${agentId}`, updatedAt: 1 },
          );
        }
        mocks.caller.mockReturnValue(undefined);
        mocks.loadSession.mockImplementation(loadGatewaySessionEntryReadOnly);
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
      });
    },
  );

  it("rejects a publication whose session authorization changes while verification waits", async () => {
    let resolveRequest: ((value: Awaited<ReturnType<typeof mocks.request>>) => void) | undefined;
    mocks.request.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
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
      { sessionKey: "agent:main:dashboard:task", idempotencyKey: "publication-revoked" },
      { sessionMutationAuthorization: authorization },
    );
    await vi.waitFor(() => expect(resolveRequest).toBeTypeOf("function"));
    const requester = expectDefined(mocks.request.mock.calls[0], "publication request")[0]
      .requester;
    expect(requester.snapshot).toEqual(expectedSystemRequester.snapshot);
    expect(() => requester.assertCurrent()).not.toThrow();
    authorized = false;
    expect(() => requester.assertCurrent()).toThrow(GitHubPublicationRequesterUnavailableError);
    resolveRequest?.({
      requestId: "publication-revoked",
      status: "requested",
      message: "Publication was accepted.",
    });

    await expect(pending).rejects.toBe(changed);
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:main:dashboard:task",
      idempotencyKey: "publication-revoked",
      agentId: "main",
      expectedRunId: "run-1",
      requester,
    });
  });
});
