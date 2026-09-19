import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionGitHubStatusResult } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { clearGitHubCredentialVerificationCache } from "../../agents/github-oauth-client.js";
import { getRuntimeConfig } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  disconnectUserGitHubConnection,
  updateUserGitHubConnection,
  type UserGitHubConnection,
} from "../../state/user-github-connections.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createPersonalGitHubOAuthLifecycle,
  personalGitHubStatus,
  type PersonalGitHubAction,
} from "../github-personal-oauth.js";
import * as publicationAvailability from "../github-publication-availability.js";
import { sessionsGitHubHandlers } from "./sessions-github.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({ runCommandBuffered: vi.fn() }));
vi.mock("../../process/exec.js", () => ({ runCommandBuffered: mocks.runCommandBuffered }));
vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () => undefined,
}));
vi.mock("../github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: vi.fn(async () => {}),
}));

const sessionKey = "agent:main:publication-read";
const sessionId = "publication-read-session";
const publisher = { source: "agent-override" as const, accountId: 7, login: "shared-bot" };
const receipt = {
  result: {
    requestId: "8c698e8a-bdc7-4927-a0f2-73a842c2d7b1",
    publisher,
    status: "publishing" as const,
    message: "The shared publication is in progress.",
  },
  confirmation: null,
};

async function withReadFixture(
  run: (fixture: ReturnType<typeof createFixture>) => Promise<void>,
  options: { personal?: boolean } = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = options.personal
      ? ensureProfileForEmail("publication-reader@example.test")
      : undefined;
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId,
        updatedAt: 1,
        ...(profile
          ? { createdActor: { type: "human", source: "profile", id: profile.id } as const }
          : {}),
      },
    );
    const fixture = createFixture(profile);
    try {
      await run(fixture);
    } finally {
      await fixture.personalLifecycle.stop();
    }
  });
}

function createFixture(profile?: ReturnType<typeof ensureProfileForEmail>) {
  const client: GatewayClient = {
    connId: "publication-reader",
    ...(profile
      ? {
          authenticatedUserProfile: {
            profileId: profile.id,
            displayName: profile.displayName,
            hasAvatar: false,
            updatedAt: profile.updatedAt,
          },
        }
      : {}),
    connect: {
      role: "operator",
      scopes: ["operator.read"],
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", mode: "test", platform: "test", version: "1" },
    },
  };
  let connected = true;
  const sharedStatus = vi.fn().mockReturnValue(receipt);
  const latestShared = vi.fn().mockReturnValue(receipt);
  const personalStatus = vi.fn();
  const personalPending = vi
    .fn<() => Promise<SessionGitHubStatusResult | null>>()
    .mockResolvedValue(null);
  const personalLifecycle = createPersonalGitHubOAuthLifecycle();
  const personalConnectionStatus = vi.fn(async (action: PersonalGitHubAction) =>
    personalGitHubStatus(action),
  );
  const requestForSession = vi.fn();
  // Only these services belong to the read handler; the authorization helpers stay real.
  const context = {
    getRuntimeConfig,
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
      new Set(connected && (!filter || filter(client)) ? [client.connId] : []),
    githubPublicationService: {
      sharedStatus,
      latestShared,
      personalStatus,
      personalPending,
      requestForSession,
    },
    githubOAuthService: {
      personal: {
        ...personalLifecycle,
        status: personalConnectionStatus,
      },
    },
  } as unknown as GatewayRequestContext;
  const invoke = async (
    method: "sessions.github.options" | "sessions.github.status",
    params: Record<string, unknown>,
    respond = vi.fn(),
  ) => {
    await expectDefined(
      sessionsGitHubHandlers[method],
      method,
    )({
      params,
      respond: respond as never,
      context,
      client,
      req: { type: "req", id: "publication-read", method },
      isWebchatConnect: () => false,
    });
    return respond;
  };
  return {
    client,
    invoke,
    sharedStatus,
    latestShared,
    personalStatus,
    personalPending,
    personalLifecycle,
    personalConnectionStatus,
    requestForSession,
    disconnect: () => {
      connected = false;
    },
  };
}

beforeEach(() => {
  clearGitHubCredentialVerificationCache();
  vi.spyOn(
    publicationAvailability,
    "prepareCurrentGitHubPublicationOptionsIdentity",
  ).mockResolvedValue({
    source: publisher.source,
    account: { accountId: publisher.accountId, login: publisher.login, avatarUrl: null },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("publication receipt reads", () => {
  it("reuses native authentication for consecutive options requests and refreshes after invalidation", async () => {
    vi.mocked(publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity).mockRestore();
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    mocks.runCommandBuffered.mockReset().mockImplementation(async () => ({
      stdout: Buffer.from("synthetic-options-native"),
      stderr: Buffer.alloc(0),
      code: 0,
      termination: "exit",
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ id: 7, login: "shared-bot", avatar_url: null }),
    );
    await withReadFixture(async (fixture) => {
      for (let index = 0; index < 2; index++) {
        const respond = await fixture.invoke("sessions.github.options", { sessionKey });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            shared: { ...publisher, source: "system-detected" },
          }),
        );
      }
      expect(mocks.runCommandBuffered).toHaveBeenCalledOnce();
      expect(mocks.runCommandBuffered).toHaveBeenCalledWith(
        ["gh", "auth", "token", "--hostname", "github.com"],
        expect.any(Object),
      );
      expect(fetch).toHaveBeenCalledOnce();
      clearGitHubCredentialVerificationCache();
      await fixture.invoke("sessions.github.options", { sessionKey });
      expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(2);
    });
  });

  it("reads an accepted shared request without a personal profile or write permission", async () => {
    await withReadFixture(async (fixture) => {
      const respond = await fixture.invoke("sessions.github.status", {
        sessionKey,
        requestId: receipt.result.requestId,
      });
      expect(respond).toHaveBeenCalledWith(true, receipt);
      expect(fixture.sharedStatus).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey, sessionId, agentId: "main" }),
        receipt.result.requestId,
      );
      expect(fixture.personalStatus).not.toHaveBeenCalled();
      expect(fixture.requestForSession).not.toHaveBeenCalled();
      expect(
        publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity,
      ).not.toHaveBeenCalled();
    });
  });

  it("discovers the shared receipt and can restrict recovery to the exact invocation key", async () => {
    await withReadFixture(async (fixture) => {
      const respond = await fixture.invoke("sessions.github.options", {
        sessionKey,
        idempotencyKey: "owned-unknown-attempt",
      });
      expect(respond).toHaveBeenCalledWith(true, {
        personal: null,
        shared: publisher,
        pendingPersonal: null,
        latestShared: receipt,
      });
      expect(fixture.latestShared).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey, sessionId, agentId: "main" }),
        "owned-unknown-attempt",
      );
      expect(fixture.personalPending).not.toHaveBeenCalled();
      expect(fixture.requestForSession).not.toHaveBeenCalled();
    });
  });

  it.each(["scope", "connection", "unverified-profile"] as const)(
    "does not downgrade a failed %s check into shared access",
    async (failure) => {
      await withReadFixture(async (fixture) => {
        if (failure === "scope") {
          fixture.client.connect.scopes = [];
        } else if (failure === "connection") {
          fixture.disconnect();
        } else {
          fixture.client.authenticatedUserProfile = {
            profileId: "unverified-publication-person",
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          };
        }
        const respond = await fixture.invoke("sessions.github.status", {
          sessionKey,
          requestId: receipt.result.requestId,
        });
        expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
        expect(fixture.sharedStatus).not.toHaveBeenCalled();
        expect(fixture.personalStatus).not.toHaveBeenCalled();
      });
    },
  );

  it("does not expose personal receipts to a profileless shared reader", async () => {
    await withReadFixture(async (fixture) => {
      fixture.sharedStatus.mockReturnValue(undefined);
      const respond = await fixture.invoke("sessions.github.status", {
        sessionKey,
        requestId: receipt.result.requestId,
      });
      expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(fixture.personalStatus).not.toHaveBeenCalled();
    });
  });

  it.each([
    "unchanged",
    "scope",
    "connection",
    "profile",
    "session-lifecycle",
    "github-unchanged",
    "github-unavailable",
    "github-generation",
    "github-account",
    "github-disconnect",
  ] as const)(
    "rechecks %s authority before reading shared receipts after a pending personal read",
    async (change) => {
      await withReadFixture(
        async (fixture) => {
          const owner = expectDefined(
            fixture.client.authenticatedUserProfile,
            "reader profile",
          ).profileId;
          const hasGitHubConnection = change.startsWith("github-");
          const connection = {
            version: 1,
            generation: "d1b37521-a10c-482c-a1d9-ce1390ccbf89",
            selection: {
              kind: "connected",
              profileId: "ghp_22222222222222222222222222222222",
              accountId: 42,
              login: "reader",
              refreshToken: "synthetic-read-refresh",
              accessExpiresAtMs: Date.now() + 3_600_000,
              refreshExpiresAtMs: Date.now() + 86_400_000,
              scopes: ["repo"],
            },
          } satisfies UserGitHubConnection;
          if (hasGitHubConnection) {
            updateUserGitHubConnection(
              owner,
              () => connection,
              () => {},
            );
          }
          if (change === "github-unavailable") {
            fixture.personalConnectionStatus.mockImplementationOnce(async (action) => ({
              ...personalGitHubStatus(action),
              state: "unavailable",
            }));
          }
          const entered = createDeferredCore();
          const pending = createDeferredCore<SessionGitHubStatusResult | null>();
          const personalReceipt: SessionGitHubStatusResult = {
            ...receipt,
            result: {
              ...receipt.result,
              publisher: { source: "personal", accountId: 42, login: "reader" },
            },
          };
          fixture.personalPending.mockImplementationOnce(() => {
            entered.resolve();
            return pending.promise;
          });
          const respond = vi.fn();
          const request = fixture.invoke("sessions.github.options", { sessionKey }, respond);
          try {
            await Promise.race([
              entered.promise,
              request.then(() => {
                throw new Error("Options completed before the personal receipt read started.");
              }),
            ]);
            expect(respond).not.toHaveBeenCalled();
            expect(fixture.latestShared).not.toHaveBeenCalled();

            if (change === "scope") {
              fixture.client.connect.scopes = [];
            } else if (change === "connection") {
              fixture.disconnect();
            } else if (change === "profile") {
              expectDefined(fixture.client.authenticatedUserProfile, "reader profile").profileId =
                ensureProfileForEmail("replacement-reader@example.test").id;
            } else if (change === "session-lifecycle") {
              await upsertSessionEntryCore(
                { agentId: "main", sessionKey },
                { lifecycleRevision: "replaced-publication-session" },
              );
            } else if (change === "github-generation") {
              updateUserGitHubConnection(
                owner,
                () => ({
                  ...connection,
                  generation: "6a7862d3-9895-4905-a4fb-f16f143aed3e",
                }),
                () => {},
              );
            } else if (change === "github-account") {
              updateUserGitHubConnection(
                owner,
                () => ({
                  ...connection,
                  selection: {
                    ...connection.selection,
                    accountId: 43,
                    login: "replacement-reader",
                  },
                }),
                () => {},
              );
            } else if (change === "github-disconnect") {
              disconnectUserGitHubConnection(owner, () => {});
            }
            const pendingPersonal = hasGitHubConnection ? null : personalReceipt;
            pending.resolve(pendingPersonal);
            await request;

            expect(respond).toHaveBeenCalledOnce();
            expect(fixture.personalConnectionStatus).toHaveBeenCalledOnce();
            if (
              change === "unchanged" ||
              change === "github-unchanged" ||
              change === "github-unavailable"
            ) {
              expect(respond).toHaveBeenCalledWith(true, {
                personal: {
                  state:
                    change === "github-unavailable"
                      ? "unavailable"
                      : hasGitHubConnection
                        ? "connected"
                        : "disconnected",
                  generation: hasGitHubConnection ? connection.generation : null,
                  account: hasGitHubConnection ? { accountId: 42, login: "reader" } : null,
                  accessExpiresAtMs: hasGitHubConnection
                    ? connection.selection.accessExpiresAtMs
                    : null,
                  refreshState: hasGitHubConnection ? "available" : "not_applicable",
                  pending: null,
                },
                shared: publisher,
                pendingPersonal,
                latestShared: receipt,
              });
              expect(fixture.latestShared).toHaveBeenCalledOnce();
            } else {
              expect(respond).toHaveBeenCalledWith(
                false,
                undefined,
                expect.objectContaining({ code: "FORBIDDEN" }),
              );
              expect(fixture.latestShared).not.toHaveBeenCalled();
            }
          } finally {
            pending.resolve(null);
            await request;
          }
        },
        { personal: true },
      );
    },
  );

  it("rechecks the connection before replying after the shared receipt read", async () => {
    await withReadFixture(
      async (fixture) => {
        fixture.latestShared.mockImplementationOnce(() => {
          fixture.disconnect();
          return receipt;
        });

        const respond = await fixture.invoke("sessions.github.options", { sessionKey });

        expect(fixture.personalPending).toHaveBeenCalledOnce();
        expect(fixture.latestShared).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
      },
      { personal: true },
    );
  });
});
