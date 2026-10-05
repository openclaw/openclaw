import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionGitHubStatusResult } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { clearGitHubCredentialVerificationCache } from "../../agents/github-oauth-client.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  updateUserGitHubConnection,
  type UserGitHubConnection,
} from "../../state/user-github-connections.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import * as prRead from "../control-ui-session-pr-read.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import { personalGitHubStatus } from "../github-personal-oauth.js";
import * as publicationAvailability from "../github-publication-availability.js";
import * as relevance from "../github-publication-relevance.js";
import * as requesterAuthority from "../github-publication-requester.js";
import {
  publisher,
  receipt,
  sessionId,
  sessionKey,
  withReadFixture,
} from "./sessions-github-read.test-support.js";

const mocks = vi.hoisted(() => ({ runCommandBuffered: vi.fn() }));
vi.mock("../../process/exec.js", () => ({ runCommandBuffered: mocks.runCommandBuffered }));
vi.mock("../../agents/tools/gateway-caller-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/gateway-caller-context.js")>()),
  getGatewayToolCallerIdentity: () => undefined,
}));
vi.mock("../github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: vi.fn(async () => {}),
}));

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("publication receipt reads", () => {
  it.each([
    "cold",
    "requester timeout",
    "credential timeout",
    "revoked",
    "app cold",
    "app timeout",
    "app revoked",
  ] as const)(
    "bounds admitted options separately from cold requester preparation: %s",
    async (mode) => {
      await withReadFixture(async (fixture) => {
        vi.stubEnv("FACTORY_AUTH_MODE", "github");
        const app = mode.startsWith("app ");
        if (app) {
          vi.spyOn(publicationAvailability, "currentGitHubPublicationConfig").mockReturnValue({
            tools: {
              github: {
                profileId: "ghp_11111111111111111111111111111111",
                kind: "app-installation",
                app: {
                  appId: 1,
                  installationId: 2,
                  accountId: 3,
                  repositories: [{ id: 4, fullName: "synthetic/repo" }],
                  permissions: { metadata: "read" },
                  privateKey: { source: "env", provider: "default", id: "SYNTHETIC_KEY" },
                  keyVersion: "synthetic",
                },
              },
            },
          });
        }
        const captured = createDeferredCore();
        const requester = createDeferredCore();
        const credential = createDeferredCore();
        const lookup = createDeferredCore();
        const release = vi.fn();
        let current = true;
        const assertCurrent = () => {
          if (!current) {
            throw new Error("Original requester revoked");
          }
        };
        vi.spyOn(requesterAuthority, "captureGitHubPublicationRequester").mockImplementation(
          async () => {
            captured.resolve();
            await requester.promise;
            return {
              requester: {
                snapshot: {
                  version: 1,
                  actor: { kind: "system" },
                  scopes: ["operator.admin"],
                  grant: null,
                },
                assertCurrent,
                assertInvocationCurrent: assertCurrent,
              },
              release,
            };
          },
        );
        vi.mocked(
          publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity,
        ).mockImplementation(async (_agent, actor, proof) => {
          actor?.assertCurrent?.();
          proof?.assertCurrent();
          lookup.resolve();
          await credential.promise;
          actor?.assertCurrent?.();
          proof?.assertCurrent();
          return {
            source: "system-detected",
            account: { accountId: 7, login: "shared-bot", avatarUrl: null },
          };
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const respond = vi.fn();
        const request = fixture.invoke("sessions.github.options", { sessionKey }, respond);
        try {
          await awaitGateBeforeSettlement(
            captured.promise,
            request,
            "Requester preparation not entered",
          );
          if (mode === "requester timeout") {
            await vi.advanceTimersByTimeAsync(5_000);
            await request;
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              expect.objectContaining({
                code: "UNAVAILABLE",
                retryable: true,
                details: { phase: "requester", requestId: "publication-read" },
              }),
            );
            requester.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(release).toHaveBeenCalledOnce();
            expect(
              publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity,
            ).not.toHaveBeenCalled();
          } else {
            await vi.advanceTimersByTimeAsync(2_576);
            requester.resolve();
            await awaitGateBeforeSettlement(
              lookup.promise,
              request,
              "Credential preparation not entered",
            );
            await vi.advanceTimersByTimeAsync(
              mode === "app timeout"
                ? 25_000
                : mode === "credential timeout"
                  ? 5_000
                  : app
                    ? 6_000
                    : 3_228,
            );
            if (mode === "credential timeout" || mode === "app timeout") {
              await request;
              expect(respond).toHaveBeenCalledExactlyOnceWith(
                false,
                undefined,
                expect.objectContaining({
                  code: "UNAVAILABLE",
                  details: { phase: "shared_identity", requestId: "publication-read" },
                }),
              );
            } else {
              expect(respond).not.toHaveBeenCalled();
              if (mode === "revoked" || mode === "app revoked") {
                current = false;
              }
            }
            credential.resolve();
            await request;
            await vi.advanceTimersByTimeAsync(0);
            expect(respond).toHaveBeenCalledOnce();
            if (mode === "cold" || mode === "app cold") {
              expect(respond).toHaveBeenCalledWith(
                true,
                expect.objectContaining({ shared: { ...publisher, source: "system-detected" } }),
              );
            } else if (mode === "revoked" || mode === "app revoked") {
              expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
            }
            expect(release).toHaveBeenCalledOnce();
          }
          expect(fixture.requestForSession).not.toHaveBeenCalled();
        } finally {
          requester.resolve();
          credential.resolve();
          await vi.advanceTimersByTimeAsync(0);
          await request;
        }
      });
    },
  );
  it("records rejected credential preparation without exposing its private exception", async () => {
    vi.mocked(publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity).mockRestore();
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    mocks.runCommandBuffered.mockRejectedValueOnce(new Error("synthetic-private-token-header"));
    await withReadFixture(async (fixture) => {
      const respond = await fixture.invoke("sessions.github.options", { sessionKey });
      expect(respond).toHaveBeenCalledOnce();
      expect(fixture.readDiagnostics).toHaveBeenCalledWith(
        "sessions.github.read.preparation",
        expect.objectContaining({
          requestId: "publication-read",
          sessionId,
          sessionKey,
          subphase: "credential_read",
          outcome: "rejected",
        }),
      );
      expect(JSON.stringify(fixture.readDiagnostics.mock.calls)).not.toContain(
        "synthetic-private-token-header",
      );
      expect(fixture.requestForSession).not.toHaveBeenCalled();
    });
  });
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
        const respond = await fixture.invoke("sessions.github.options", {
          sessionKey,
          idempotencyKey: "owned-unknown-attempt",
        });
        expect(respond).toHaveBeenCalledWith(true, {
          personal: null,
          shared: { ...publisher, source: "system-detected" },
          pendingPersonal: null,
          latestShared: receipt,
        });
        expect(fixture.latestShared).toHaveBeenCalledWith(
          expect.objectContaining({ sessionKey, sessionId, agentId: "main" }),
          "owned-unknown-attempt",
          expect.any(Function),
        );
        expect(fixture.personalPending).not.toHaveBeenCalled();
        expect(fixture.requestForSession).not.toHaveBeenCalled();
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

  it.each([false, true])(
    "reconciles published coverage with current read authority (revoked=%s)",
    async (revoked) => {
      await withReadFixture(async (fixture) => {
        const snapshot = {
          repository: "owner/repo",
          branch: "feature",
          source_head_commit: "1".repeat(40),
          workspace_tree: "2".repeat(40),
        };
        const target = {
          sessionId,
          params: { sessionKey, agentId: "main" },
          identity: "pr-source",
          readSource: { agentId: "main", path: "/fixture" },
          source: { owner: "owner", repo: "repo", branch: "feature" },
          assertCurrent: vi.fn(),
        };
        vi.spyOn(prRead, "prepareControlUiSessionPrRead").mockResolvedValue(async () => target);
        const prs = [
          {
            owner: "owner",
            repo: "repo",
            number: 1,
            title: "Published work",
            url: "https://github.com/owner/repo/pull/1",
            branch: "feature",
            headSha: "3".repeat(40),
            state: "merged",
          },
        ];
        fixture.pullRequests.read.mockImplementation(async () => {
          if (revoked) {
            fixture.disconnect();
          }
          return { pullRequests: prs, status: "ready", rateLimited: false };
        });
        const covered = vi
          .spyOn(relevance, "isGitHubPublicationSuperseded")
          .mockResolvedValue(true);
        fixture.latestShared.mockImplementation(async (_session, _key, isSuperseded) =>
          (await isSuperseded(snapshot)) ? null : receipt,
        );
        const respond = await fixture.invoke("sessions.github.options", { sessionKey });
        if (revoked) {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "FORBIDDEN" }),
          );
          expect(covered).not.toHaveBeenCalled();
        } else {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ latestShared: null }),
          );
          expect(covered).toHaveBeenCalledWith(
            snapshot,
            prs,
            expect.objectContaining({ assertCurrent: expect.any(Function) }),
          );
        }
        expect(fixture.pullRequests.read).toHaveBeenCalledWith(
          target,
          expect.any(Function),
          "publication",
        );
        expect(fixture.requestForSession).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["refresh", "native", "verification", "personal", "receipt"] as const)(
    "bounds a stalled %s read and prevents late work or a second response",
    async (phase) => {
      await withReadFixture(
        async (fixture) => {
          const entered = createDeferredCore();
          const pending = createDeferredCore();
          const hold = async () => {
            entered.resolve();
            await pending.promise;
          };
          if (phase === "refresh" || phase === "native" || phase === "verification") {
            vi.mocked(
              publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity,
            ).mockRestore();
            if (phase === "refresh") {
              vi.mocked(requestCurrentGitHubOAuthRefresh).mockImplementationOnce(hold);
            } else {
              vi.stubEnv("GH_TOKEN", undefined);
              vi.stubEnv("GITHUB_TOKEN", undefined);
              mocks.runCommandBuffered.mockImplementationOnce(async () => {
                if (phase === "native") {
                  await hold();
                }
                return {
                  stdout: Buffer.from("synthetic-cold-native"),
                  stderr: Buffer.alloc(0),
                  code: 0,
                  termination: "exit",
                };
              });
              vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
                if (phase === "verification") {
                  await hold();
                }
                return Response.json({ id: 7, login: "shared-bot", avatar_url: null });
              });
            }
            mocks.runCommandBuffered.mockClear();
          } else if (phase === "personal") {
            fixture.personalConnectionStatus.mockImplementationOnce(async (action) => {
              await hold();
              return personalGitHubStatus(action);
            });
          } else {
            fixture.latestShared.mockImplementationOnce(async () => {
              await hold();
              return receipt;
            });
          }
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          const respond = vi.fn();
          const traceId = "a".repeat(32);
          const request = runWithDiagnosticTraceContext({ traceId }, () =>
            fixture.invoke("sessions.github.options", { sessionKey }, respond),
          );
          try {
            await awaitGateBeforeSettlement(entered.promise, request, "Held read did not start");
            await vi.advanceTimersByTimeAsync(4_999);
            expect(respond).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              expect.objectContaining({
                code: "UNAVAILABLE",
                message:
                  phase === "refresh" || phase === "native" || phase === "verification"
                    ? "GitHub account verification is still preparing; refresh publication options to retry. No publication was requested."
                    : "GitHub publication options timed out after 5 seconds; retry the request.",
                retryable: true,
                details: {
                  phase:
                    phase === "refresh" || phase === "native" || phase === "verification"
                      ? "shared_identity"
                      : phase === "personal"
                        ? "personal_status"
                        : "shared_receipt",
                  requestId: "publication-read",
                },
              }),
            );
            await request;
            if (phase === "refresh" || phase === "native" || phase === "verification") {
              const subphase =
                phase === "refresh"
                  ? "oauth_refresh"
                  : phase === "native"
                    ? "credential_read"
                    : "user_verification";
              expect(fixture.readDiagnostics).toHaveBeenCalledWith(
                "sessions.github.read.preparation",
                expect.objectContaining({
                  requestId: "publication-read",
                  traceId,
                  sessionId,
                  sessionKey,
                  subphase,
                  outcome: "started",
                }),
              );
              expect(fixture.readDiagnostics).toHaveBeenLastCalledWith(
                "sessions.github.read",
                expect.objectContaining({
                  requestId: "publication-read",
                  traceId,
                  sessionId,
                  sessionKey,
                  identityPreparation: expect.objectContaining({
                    [subphase]: expect.objectContaining({
                      outcome: "timeout",
                      durationMs: expect.any(Number),
                    }),
                  }),
                }),
              );
              expect(JSON.stringify(fixture.readDiagnostics.mock.calls)).not.toContain(
                "synthetic-cold-native",
              );
            }
            const diagnosticCount = fixture.readDiagnostics.mock.calls.length;
            pending.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(respond).toHaveBeenCalledOnce();
            expect(fixture.readDiagnostics).toHaveBeenCalledTimes(diagnosticCount);
            expect(fixture.requestForSession).not.toHaveBeenCalled();
            if (phase === "refresh") {
              expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
              expect(fixture.personalConnectionStatus).not.toHaveBeenCalled();
            }
            if (phase !== "receipt") {
              expect(fixture.latestShared).not.toHaveBeenCalled();
            }
          } finally {
            pending.resolve();
            await vi.advanceTimersByTimeAsync(0);
            vi.useRealTimers();
            await request;
          }
        },
        { personal: true },
      );
    },
  );

  it.each(["accepted", "missing", "scope", "connection", "unverified-profile"] as const)(
    "limits profileless receipt reads to authorized shared state (%s)",
    async (outcome) => {
      await withReadFixture(async (fixture) => {
        if (outcome === "scope") {
          fixture.client.connect.scopes = [];
        } else if (outcome === "connection") {
          fixture.disconnect();
        } else if (outcome === "unverified-profile") {
          fixture.client.authenticatedUserProfile = {
            profileId: "unverified-publication-person",
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          };
        } else if (outcome === "missing") {
          fixture.sharedStatus.mockResolvedValue(undefined);
        }
        const respond = await fixture.invoke("sessions.github.status", {
          sessionKey,
          requestId: receipt.result.requestId,
        });
        if (outcome === "accepted") {
          expect(respond).toHaveBeenCalledWith(true, receipt);
          expect(fixture.sharedStatus).toHaveBeenCalledWith(
            expect.objectContaining({ sessionKey, sessionId, agentId: "main" }),
            receipt.result.requestId,
          );
          expect(fixture.requestForSession).not.toHaveBeenCalled();
          expect(
            publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity,
          ).not.toHaveBeenCalled();
        } else {
          expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
          expect(fixture.sharedStatus).toHaveBeenCalledTimes(outcome === "missing" ? 1 : 0);
        }
        expect(fixture.personalStatus).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    ...[
      "unchanged",
      "scope",
      "connection",
      "profile",
      "session-lifecycle",
      "github-unchanged",
      "github-unavailable",
      "github-generation",
      "github-account",
    ].map((change) => ({ change, phase: "personal" })),
    // Both authority owners must also run after the later shared read.
    ...["connection", "github-generation"].map((change) => ({ change, phase: "shared" })),
  ])("rechecks $change authority after a pending $phase read", async ({ change, phase }) => {
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
        fixture.personalPending.mockResolvedValue(hasGitHubConnection ? null : personalReceipt);
        const heldRead = phase === "personal" ? fixture.personalPending : fixture.latestShared;
        heldRead.mockImplementationOnce(() => {
          entered.resolve();
          return pending.promise;
        });
        const respond = vi.fn();
        const request = fixture.invoke("sessions.github.options", { sessionKey }, respond);
        try {
          await Promise.race([
            entered.promise,
            request.then(() => {
              throw new Error("Options completed before the held receipt read started.");
            }),
          ]);
          expect(respond).not.toHaveBeenCalled();
          if (phase === "personal") {
            expect(fixture.latestShared).not.toHaveBeenCalled();
          } else {
            expect(fixture.latestShared).toHaveBeenCalledOnce();
          }

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
          }
          const pendingPersonal = hasGitHubConnection ? null : personalReceipt;
          pending.resolve(phase === "personal" ? pendingPersonal : receipt);
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
            if (phase === "personal") {
              expect(fixture.latestShared).not.toHaveBeenCalled();
            } else {
              expect(fixture.latestShared).toHaveBeenCalledOnce();
            }
          }
        } finally {
          pending.resolve(null);
          await request;
        }
      },
      { personal: true },
    );
  });

  it("sessions.github.status rechecks the connection after an awaited shared receipt read", async () => {
    await withReadFixture(
      async (fixture) => {
        const entered = createDeferredCore();
        const pending = createDeferredCore<SessionGitHubStatusResult>();
        const sharedRead = fixture.sharedStatus;
        sharedRead.mockImplementationOnce(() => {
          entered.resolve();
          return pending.promise;
        });
        const respond = vi.fn();
        const request = fixture.invoke(
          "sessions.github.status",
          { sessionKey, requestId: receipt.result.requestId },
          respond,
        );
        try {
          await Promise.race([
            entered.promise,
            request.then(() => {
              throw new Error("Read completed before entering the held shared receipt read");
            }),
          ]);
          expect(respond).not.toHaveBeenCalled();
          fixture.disconnect();
          pending.resolve(receipt);
          await request;
          expect(sharedRead).toHaveBeenCalledOnce();
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({ code: "FORBIDDEN" }),
          );
        } finally {
          pending.resolve(receipt);
          await request;
        }
      },
      { personal: true },
    );
  });
});
