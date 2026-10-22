import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionGitHubStatusResult } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import {
  clearGitHubCredentialVerificationCache,
  verifyGitHubCredential,
} from "../../agents/github-oauth-client.js";
import {
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../../agents/github-tool-identity.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateWriter from "../../state/openclaw-state-worker-owner.js";
import type { UserGitHubConnection } from "../../state/user-github-connections.js";
import { updateUserGitHubConnection } from "../../state/user-github-connections.test-support.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import * as prRead from "../control-ui-session-pr-read.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import { personalGitHubStatusAsync as personalGitHubStatus } from "../github-personal-status.js";
import * as publicationAvailability from "../github-publication-availability.js";
import * as relevance from "../github-publication-relevance.js";
import {
  expectFailure,
  expectReply,
  mockPublicationIdentity,
  optionsResult,
  publisher,
  publisherIdentity,
  receipt,
  sessionId,
  sessionKey,
  withHeldReceipt,
  withReadFixture,
  type ReadFixture,
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
  mockPublicationIdentity();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const detectedPublisher = { ...publisher, source: "system-detected" };
const disconnected = { personal: expect.objectContaining({ state: "disconnected" }) };
type Respond = ReturnType<typeof vi.fn>;
const ownerOf = (fixture: ReadFixture) =>
  expectDefined(fixture.client.authenticatedUserProfile, "reader profile").profileId;
const saveConnection = (owner: string, connection: UserGitHubConnection) =>
  updateUserGitHubConnection(
    owner,
    () => connection,
    () => {},
  );
const expectOptions = (respond: Respond, overrides: Record<string, unknown> = {}) =>
  expectReply(respond, optionsResult(overrides));
const expectPartialReply = (respond: Respond, result: Record<string, unknown>) =>
  expectReply(respond, expect.objectContaining(result));
function useRealIdentity(token?: string) {
  vi.mocked(publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity).mockRestore();
  vi.stubEnv("GH_TOKEN", token);
  vi.stubEnv("GITHUB_TOKEN", undefined);
}
const commandResult = (token = "", code = 0) => ({
  stdout: Buffer.from(token),
  stderr: Buffer.alloc(0),
  code,
  termination: "exit" as const,
});
const accountResponse = (id = 7, login = "shared-bot") =>
  Response.json({ id, login, avatar_url: null });
function githubConnection(
  profileId: string,
  login: string,
  refreshToken: string,
  now = Date.now(),
) {
  return {
    version: 1,
    generation: "d1b37521-a10c-482c-a1d9-ce1390ccbf89",
    selection: {
      kind: "connected",
      profileId,
      accountId: 42,
      login,
      refreshToken,
      accessExpiresAtMs: now + 3_600_000,
      refreshExpiresAtMs: now + 86_400_000,
      scopes: ["repo"],
    },
  } satisfies UserGitHubConnection;
}
const withPersonalReadFixture = (run: Parameters<typeof withReadFixture>[0]) =>
  withReadFixture(run, { personal: true });

it("reads cold personal options while writer dispatch is unavailable", async () => {
  await withPersonalReadFixture(async (fixture) => {
    fixture.personalConnectionStatus.mockImplementation(fixture.personalLifecycle.status);
    const writer = vi.spyOn(stateWriter, "getOpenClawStateWorkerOwner").mockImplementation(() => {
      throw new Error("Writer dispatch unavailable");
    });
    try {
      const respond = await fixture.options();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, optionsResult(disconnected));
    } finally {
      writer.mockRestore();
    }
  });
});

it("reads personal options and receipts while shared identity discovery is pending", async ({
  signal,
}) => {
  await withPersonalReadFixture(async (fixture) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    vi.mocked(
      publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity,
    ).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return publisherIdentity();
    });
    const respond = vi.fn();
    const request = fixture.options(respond, { idempotencyKey: "owned-unknown-attempt" });
    try {
      await withinTest(entered.promise, signal);
      expect(fixture.personalConnectionStatus).toHaveBeenCalledOnce();
      expect(fixture.personalPending).toHaveBeenCalledOnce();
      expect(fixture.latestShared).toHaveBeenCalledOnce();
      expect(fixture.latestShared).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey, sessionId, agentId: "main" }),
        "owned-unknown-attempt",
        expect.any(Function),
        expect.any(Function),
      );
      expect(respond).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await request;
    }
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, optionsResult(disconnected));
  });
});

it.each([
  { httpStatus: 401, reason: "unavailable" },
  { httpStatus: 429, reason: "rate_limited" },
  { httpStatus: 503, reason: "unverified" },
])(
  "reports $reason without discarding personal account options",
  async ({ httpStatus, reason }) => {
    useRealIdentity();
    mocks.runCommandBuffered
      .mockReset()
      .mockResolvedValue(commandResult(`synthetic-options-${reason}`));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: httpStatus }));
    await withPersonalReadFixture(async (fixture) => {
      const respond = await fixture.options();
      expectOptions(respond, { ...disconnected, shared: null, sharedUnavailableReason: reason });
      expect(fixture.personalConnectionStatus).toHaveBeenCalledOnce();
      expect(fixture.requestForSession).not.toHaveBeenCalled();
    });
  },
);

it.for(["token", "native"] as const)(
  "serves stale options while %s authentication refreshes without waiting",
  async (source, { signal }) => {
    useRealIdentity(source === "token" ? "synthetic-options-stale-token" : undefined);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const credentialRefresh = createDeferredCore<Response>();
    const nativeRefresh = createDeferredCore<ReturnType<typeof commandResult>>();
    const entered = createDeferredCore();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(accountResponse());
    if (source === "token") {
      fetchMock.mockResolvedValueOnce(accountResponse()).mockReturnValue(credentialRefresh.promise);
    } else {
      mocks.runCommandBuffered
        .mockReset()
        .mockResolvedValueOnce(commandResult("synthetic-options-native-expired"))
        .mockImplementation(() => {
          entered.resolve();
          return nativeRefresh.promise;
        });
    }
    await withReadFixture(async (fixture) => {
      await fixture.options();
      now.mockReturnValue(61_001);
      const request = fixture.options();
      try {
        if (source === "native") {
          await withinTest(entered.promise, signal);
        }
        const stale =
          source === "native"
            ? await awaitGateBeforeSettlement(
                request,
                nativeRefresh.promise,
                "Warm options waited for native authentication",
              )
            : await withinTest(request, signal);
        expectPartialReply(stale, {
          stale: true,
          shared: detectedPublisher,
        });
        if (source === "token") {
          expect(fetchMock).toHaveBeenCalledTimes(2);
          fixture.disconnect();
          expect((await fixture.options()).mock.calls[0]?.[0]).toBe(false);
        }
      } finally {
        credentialRefresh.resolve(accountResponse());
        nativeRefresh.resolve(commandResult("", 1));
        await request;
      }
      if (source === "native") {
        expectPartialReply(await fixture.options(), {
          shared: null,
          sharedUnavailableReason: "unavailable",
        });
      }
    });
  },
);

it("marks only expired personal account facts stale through options revalidation", async ({
  signal,
}) => {
  const personalToken = "synthetic-personal-options-stale";
  const sharedToken = "synthetic-shared-options-fresh";
  vi.mocked(publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity).mockRestore();
  vi.stubEnv("GH_TOKEN", sharedToken);
  mocks.runCommandBuffered.mockResolvedValue(commandResult(sharedToken));
  const refresh = createDeferredCore<Response>();
  let personalProbes = 0;
  let sharedProbes = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    if (new Headers(init?.headers).get("Authorization") === `Bearer ${personalToken}`) {
      personalProbes += 1;
      return personalProbes === 1 ? accountResponse(42, "personal-reader") : refresh.promise;
    }
    sharedProbes += 1;
    return accountResponse();
  });
  await withPersonalReadFixture(async (fixture) => {
    const owner = ownerOf(fixture);
    const profileId = "ghp_33333333333333333333333333333333";
    await writeManagedGitHubProfileFiles(
      resolveManagedGitHubProfileDir({ agentId: "", scope: "personal", profileId }),
      { login: "personal-reader", token: personalToken },
    );
    const initialNow = Date.now();
    saveConnection(
      owner,
      githubConnection(profileId, "personal-reader", "synthetic-personal-refresh", initialNow),
    );
    fixture.personalConnectionStatus.mockImplementation(fixture.personalLifecycle.status);
    const now = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    try {
      await verifyGitHubCredential(personalToken);
      now.mockReturnValue(initialNow + 30_000);
      await fixture.options();
      now.mockReturnValue(initialNow + 60_001);
      const result = await withinTest(fixture.options(), signal);
      expectPartialReply(result, {
        stale: true,
        personal: expect.objectContaining({ state: "connected", stale: true }),
        shared: detectedPublisher,
      });
      expect(personalProbes).toBe(2);
      expect(sharedProbes).toBe(1);
    } finally {
      refresh.resolve(accountResponse(42, "personal-reader"));
      await verifyGitHubCredential(personalToken);
    }
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
        params: { sessionKey, agentId: "main" },
        identity: "pr-source",
        readSource: { agentId: "main", path: "/fixture" },
        source: { owner: "owner", repo: "repo", branch: "feature" },
        assertCurrent: vi.fn(),
      };
      vi.spyOn(prRead, "createControlUiSessionPrRead").mockReturnValue(async () => target);
      const prs = [
        {
          ...target.source,
          number: 1,
          title: "Published work",
          url: "https://github.com/owner/repo/pull/1",
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
      const covered = vi.spyOn(relevance, "isGitHubPublicationSuperseded").mockResolvedValue(true);
      fixture.latestShared.mockImplementation(async (_session, _key, isSuperseded) =>
        (await isSuperseded(snapshot)) ? null : receipt,
      );
      const respond = await fixture.options();
      if (revoked) {
        expectFailure(respond);
        expect(covered).not.toHaveBeenCalled();
      } else {
        expectPartialReply(respond, { latestShared: null });
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

it.each(["refresh", "personal", "receipt"] as const)(
  "bounds a stalled %s read and prevents late work or a second response",
  async (phase) => {
    await withPersonalReadFixture(async (fixture) => {
      const entered = createDeferredCore();
      const pending = createDeferredCore();
      const hold = async () => {
        entered.resolve();
        await pending.promise;
      };
      if (phase === "refresh") {
        vi.mocked(
          publicationAvailability.prepareCurrentGitHubPublicationOptionsIdentity,
        ).mockRestore();
        vi.mocked(requestCurrentGitHubOAuthRefresh).mockImplementationOnce(hold);
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
      const request = fixture.options(respond);
      try {
        await awaitGateBeforeSettlement(entered.promise, request, "Held read did not start");
        await vi.advanceTimersByTimeAsync(4_999);
        expect(respond).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expectFailure(respond, {
          code: "UNAVAILABLE",
          message: "GitHub publication options timed out after 5 seconds; retry the request.",
          retryable: true,
        });
        expect(respond).toHaveBeenCalledOnce();
        await request;
        pending.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(respond).toHaveBeenCalledOnce();
        if (phase === "refresh") {
          expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
        }
        expect(fixture.personalConnectionStatus).toHaveBeenCalledOnce();
        expect(fixture.latestShared).toHaveBeenCalledOnce();
      } finally {
        pending.resolve();
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
        await request;
      }
    });
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
      const respond = await fixture.status();
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
  await withPersonalReadFixture(async (fixture) => {
    const owner = ownerOf(fixture);
    const hasGitHubConnection = change.startsWith("github-");
    const connection = githubConnection(
      "ghp_22222222222222222222222222222222",
      "reader",
      "synthetic-read-refresh",
    );
    if (hasGitHubConnection) {
      saveConnection(owner, connection);
    }
    const statusReady = createDeferredCore();
    fixture.personalConnectionStatus.mockImplementationOnce(async (action) => {
      const status = await personalGitHubStatus(action);
      statusReady.resolve();
      return change === "github-unavailable" ? { ...status, state: "unavailable" } : status;
    });
    const personalReceipt: SessionGitHubStatusResult = {
      ...receipt,
      result: {
        ...receipt.result,
        publisher: { source: "personal", accountId: 42, login: "reader" },
      },
    };
    fixture.personalPending.mockResolvedValue(hasGitHubConnection ? null : personalReceipt);
    await withHeldReceipt(
      fixture,
      phase === "personal" ? "personal" : "shared",
      async (respond, release) => {
        expect(fixture.latestShared).toHaveBeenCalledOnce();

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
          saveConnection(owner, {
            ...connection,
            generation: "6a7862d3-9895-4905-a4fb-f16f143aed3e",
          });
        } else if (change === "github-account") {
          saveConnection(owner, {
            ...connection,
            selection: { ...connection.selection, accountId: 43, login: "replacement-reader" },
          });
        }
        const pendingPersonal = hasGitHubConnection ? null : personalReceipt;
        await release(phase === "personal" ? pendingPersonal : receipt);

        expect(respond).toHaveBeenCalledOnce();
        expect(fixture.personalConnectionStatus).toHaveBeenCalledOnce();
        if (
          change === "unchanged" ||
          change === "github-unchanged" ||
          change === "github-unavailable"
        ) {
          expectOptions(respond, {
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
            pendingPersonal,
          });
        } else {
          expectFailure(respond);
        }
        expect(fixture.latestShared).toHaveBeenCalledOnce();
      },
      statusReady.promise,
    );
  });
});
