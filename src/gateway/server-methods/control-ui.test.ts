import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as githubIdentity from "../../agents/github-tool-identity.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  SecretSurfaceUnavailableError,
  setActiveDegradedSecretOwners,
} from "../../secrets/runtime-degraded-state.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createControlUiSessionPullRequestSubscriptions } from "../control-ui-session-pr-subscriptions.js";
import { gitHubPublicApi } from "../github-public-api.js";
import { createControlUiRequestOptions } from "./control-ui-request.test-support.js";
import { createControlUiHandlers } from "./control-ui.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { GatewayClient, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const requestOptions = createControlUiRequestOptions(() => ({
  agents: { entries: { main: {} } },
  gateway: { controlUi: { github: { token: "preview-service-token" } } },
}));

type RequestExtras = Parameters<typeof requestOptions>[2] &
  Pick<Partial<GatewayRequestHandlerOptions>, "signal" | "hasCurrentClientAuthority">;
function fixture(method: string, ...loaders: Parameters<typeof createControlUiHandlers>) {
  const handler = expectDefined(createControlUiHandlers(...loaders)[`controlUi.${method}`], method);
  const respond = vi.fn<RespondFn>();
  return {
    respond,
    send: (params: Record<string, unknown>, extra?: RequestExtras) =>
      handler({
        ...requestOptions(params, respond, extra),
        signal: extra?.signal,
        hasCurrentClientAuthority: extra?.hasCurrentClientAuthority,
      }),
  };
}

function runtime(getRuntimeConfig: () => OpenClawConfig) {
  return { context: { getRuntimeConfig } };
}

function githubTarget(number: number, repo = "openclaw", owner = "openclaw") {
  return { kind: "issue", number, owner, repo };
}

function configuredGitHub(token: string): OpenClawConfig {
  return { agents: { entries: { main: {} } }, gateway: { controlUi: { github: { token } } } };
}

const json = (value: unknown) => new Response(JSON.stringify(value));

function expectReply(respond: RespondFn, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

function expectError(respond: RespondFn, error: unknown) {
  expect(respond).toHaveBeenCalledWith(false, undefined, error);
}

function expectUnavailable(respond: RespondFn) {
  expectError(respond, expect.objectContaining({ code: "UNAVAILABLE" }));
}

function issueFields(title: string, extra: Record<string, unknown> = {}) {
  return {
    created_at: "2026-09-01T08:00:00Z",
    updated_at: "2026-09-01T09:00:00Z",
    state: "open",
    title,
    user: { login: "octocat" },
    ...extra,
  };
}

function mockGitHubFetch(issue: Record<string, unknown>, repository: Record<string, unknown>) {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    json(
      (input instanceof Request ? input.url : input.toString()).includes("/issues/")
        ? issue
        : repository,
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("controlUi.githubPreview", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    setActiveDegradedSecretOwners([]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(["revoked", "copied", "aborted", "aborted-after-preparation"] as const)(
    "rejects %s requests before GitHub",
    async (state) => {
      const client = { ...identifiedClient("preview-reader"), connId: "preview-connection" };
      const controller = new AbortController();
      if (state === "aborted") {
        controller.abort();
      }
      const loadPreview = vi.fn();
      const { respond, send } = fixture("githubPreview", loadPreview);
      const pending = send(githubTarget(1, "repo", "octocat"), {
        client: state === "copied" ? { ...client } : client,
        context: {
          getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
          getClientConnIds: (filter: (current: GatewayClient) => boolean) =>
            new Set(filter(client) ? [client.connId] : []),
        },
        signal: controller.signal,
        ...(state === "revoked" ? { hasCurrentClientAuthority: () => false } : {}),
      });
      if (state === "aborted-after-preparation") {
        controller.abort();
      }
      await pending;
      expect(loadPreview).not.toHaveBeenCalled();
      expectError(respond, {
        code: "UNAVAILABLE",
        message: "GitHub request is no longer active. Try again.",
        retryable: false,
      });
    },
  );

  it.each([
    { mode: "managed", method: "controlUi.githubPreview" },
    { mode: "managed", method: "controlUi.githubDetail" },
    { mode: "service", method: "controlUi.githubDetail" },
    { mode: "anonymous", method: "controlUi.githubPreview" },
  ])("reads $method as $mode", async ({ mode, method }) => {
    vi.stubEnv("GH_TOKEN", mode === "service" ? "different-ambient-token" : "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const assertSelected = vi.fn();
    const identity = {
      token: "selected-agent-github-token",
      selection: {
        source: "agent-override" as const,
        profileId: `ghp_${"a".repeat(32)}`,
        accountId: 101,
      },
      cacheScope: "selected-agent-preview",
      assertSelected,
      revalidate: vi.fn().mockResolvedValue(undefined),
      start: async <T>(start: () => T): Promise<Awaited<T>> => {
        assertSelected();
        return await start();
      },
    };
    const prepare = vi.spyOn(githubIdentity, "prepareGitHubReadIdentity");
    if (mode === "managed") {
      prepare.mockResolvedValue(identity);
    } else {
      prepare.mockRejectedValue(new githubIdentity.GitHubIdentityError("rate_limited"));
    }
    const cfg: OpenClawConfig =
      mode === "anonymous"
        ? { agents: { entries: { main: {} } } }
        : configuredGitHub(
            mode === "managed" ? "old-preview-service-token" : "configured-reader-token",
          );
    if (mode === "managed") {
      cfg.agents = {
        entries: {
          main: {},
          alternate: { tools: { github: { profileId: identity.selection.profileId } } },
        },
      };
    }
    if (mode !== "anonymous") {
      setRuntimeConfigSnapshot(cfg);
    }
    const title =
      mode === "managed" ? "Use the selected GitHub identity" : "Public metadata without a login";
    const anonymousResponse = json(issueFields(title));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (mode === "anonymous") {
        return anonymousResponse;
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      if (mode === "managed" && authorization !== `Bearer ${identity.token}`) {
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      }
      if (mode === "service" && authorization !== "Bearer configured-reader-token") {
        return new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      }
      const url = input instanceof Request ? input.url : input.toString();
      const issue = mode === "managed" ? url.endsWith("/issues/88120") : url.includes("/issues/");
      return json(
        issue
          ? issueFields(mode === "service" ? "Authenticated reader" : title, {
              created_at: mode === "service" ? "2026-09-20T08:00:00Z" : "2026-09-01T08:00:00Z",
              updated_at: mode === "service" ? "2026-09-20T09:00:00Z" : "2026-09-01T09:00:00Z",
              ...(mode === "managed"
                ? { repository_url: "https://api.github.com/repos/openclaw/openclaw" }
                : {}),
              body: mode === "managed" ? "Authenticated reader body" : "Reader body",
              comments: 0,
            })
          : { id: mode === "managed" ? 123 : 124, private: false, visibility: "public" },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { respond, send } = fixture(method.replace("controlUi.", ""));
    await send(
      {
        kind: "issue",
        number: mode === "managed" ? 88120 : mode === "service" ? 1 : 88121,
        owner: mode === "service" ? "octocat" : "openclaw",
        repo: mode === "service" ? "reader-auth" : "openclaw",
        agentId: mode === "managed" ? "alternate" : "main",
      },
      runtime(() => cfg),
    );
    expectReply(
      respond,
      expect.objectContaining(mode === "service" ? { body: "Reader body" } : { title }),
    );
    if (mode === "anonymous") {
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
    } else {
      expect(
        fetchMock.mock.calls.every(
          ([, options]) =>
            new Headers(options?.headers).get("Authorization") ===
            `Bearer ${mode === "managed" ? identity.token : "configured-reader-token"}`,
        ),
      ).toBe(true);
      if (mode === "managed") {
        expect(prepare).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: "alternate", config: cfg }),
        );
        expect(identity.revalidate).toHaveBeenCalled();
      } else {
        expect(prepare).not.toHaveBeenCalled();
      }
    }
  });

  it.each(["controlUi.githubPreview", "controlUi.githubDetail"])(
    "routes public %s with Enterprise selected",
    async (method) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: {
          github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
          controlUi: {
            github: { host: "ghe.example.test", token: "synthetic-enterprise-service" },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const fetchMock = mockGitHubFetch(
        issueFields("Public issue", {
          repository_url: "https://api.github.com/repos/openclaw/public-routing",
          body: "Public body",
          comments: 0,
        }),
        { id: 125, private: false, visibility: "public" },
      );
      const { respond, send } = fixture(method.replace("controlUi.", ""));
      await send(
        githubTarget(88121, "public-routing"),
        runtime(() => cfg),
      );
      expectReply(respond, expect.objectContaining({ title: "Public issue" }));
      expect(fetchMock).toHaveBeenCalled();
      for (const [url, options] of fetchMock.mock.calls) {
        expect(url).toMatch(/^https:\/\/api.github.com\//);
        expect(new Headers(options?.headers).get("Authorization")).toBeNull();
      }
    },
  );

  it("revalidates cached preview credentials", async () => {
    const cfg = configuredGitHub("configured-preview-token");
    setRuntimeConfigSnapshot(cfg);
    const fetchMock = mockGitHubFetch(
      issueFields("Cached preview", {
        repository_url: "https://api.github.com/repos/openclaw/configured-degraded",
      }),
      { private: false, visibility: "public" },
    );
    const { respond, send } = fixture("githubPreview");
    const target = githubTarget(70014, "configured-degraded");
    await send(
      target,
      runtime(() => cfg),
    );
    expectReply(respond, expect.objectContaining({ title: "Cached preview" }));
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        degradationState: "cold",
        paths: ["gateway.controlUi.github.token"],
        refKeys: ["store:default:PREVIEW_TOKEN"],
        reason: "secret reference was not found",
      },
    ]);
    respond.mockClear();
    await send(
      target,
      runtime(() => cfg),
    );
    expectError(respond, {
      code: "UNAVAILABLE",
      message:
        "The configured Control UI GitHub credential is unavailable. Check gateway.controlUi.github.token and its host binding, then retry.",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["agent", "system"])(
    "rechecks %s fallback identity before delivery",
    async (selection) => {
      const preview = { title: "Keep hover previews compact" };
      let cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const started = createDeferred();
      const pending = createDeferred<typeof preview>();
      const loadPreview = vi.fn(() => {
        started.resolve();
        return pending.promise;
      });
      const { respond, send } = fixture("githubPreview", loadPreview);
      const request = send(
        githubTarget(99815),
        runtime(() => cfg),
      );
      await started.promise;
      const tools = { github: { profileId: `ghp_${"c".repeat(32)}` } };
      if (selection === "agent") {
        cfg = { agents: { entries: { main: { tools } } } };
      } else if (selection === "system") {
        cfg = { ...cfg, tools };
      }
      pending.resolve(preview);
      await request;

      expectError(respond, {
        code: "UNAVAILABLE",
        message: new githubIdentity.GitHubIdentityError("changed").message,
        retryable: false,
      });
    },
  );

  it.each([
    { name: "explicit refresh", owner: "openclaw", refresh: true, valid: true },
    { name: "malformed refresh", owner: "openclaw", refresh: "true", valid: false },
    { name: "malformed owner", owner: "openclaw/evil", refresh: undefined, valid: false },
  ])("validates $name", async ({ owner, refresh, valid }) => {
    const target = githubTarget(99817, "openclaw", owner);
    const preview = {
      ...target,
      login: "octocat",
      state: "open",
      title: "Refreshed preview",
      createdAt: "2026-09-01T08:00:00Z",
      updatedAt: "2026-09-01T09:00:00Z",
    };
    const loadPreview = vi.fn();
    if (owner === "openclaw") {
      loadPreview.mockResolvedValue(preview);
    }
    const { respond, send } = fixture("githubPreview", loadPreview);
    await send({ ...target, ...(refresh !== undefined ? { refresh } : {}) });
    if (valid) {
      expect(loadPreview).toHaveBeenCalledExactlyOnceWith(
        target,
        undefined,
        undefined,
        true,
        undefined,
      );
      expectReply(respond, preview);
    } else {
      expect(loadPreview).not.toHaveBeenCalled();
      expectError(respond, {
        code: "INVALID_REQUEST",
        message: "invalid controlUi.githubPreview params",
      });
    }
  });

  it.each([
    [
      "managed identity unavailable",
      true,
      new githubIdentity.GitHubIdentityError("unavailable"),
      "The selected GitHub credential is unavailable; reconnect the agent's GitHub identity in Settings.",
      false,
    ],
    ...(["unverified", "rate_limited"] as const).map(
      (reason) =>
        [
          "managed identity " + reason,
          true,
          new githubIdentity.GitHubIdentityError(reason),
          new githubIdentity.GitHubIdentityError(reason).message,
          false,
        ] as const,
    ),
    [
      "GitHub quota",
      false,
      new gitHubPublicApi.ControlUiGitHubError(429, "rate limited"),
      "GitHub API rate limit exceeded (HTTP 429). Wait and retry.",
      true,
    ],
    [
      "configured-unavailable preview credential",
      false,
      new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        paths: ["gateway.controlUi.github.token"],
        refKeys: [],
        reason: "secret reference was not found",
      }),
      "The configured Control UI GitHub credential is unavailable. Check gateway.controlUi.github.token and its host binding, then retry.",
      false,
    ],
  ] as const)(
    "preserves the %s diagnostic",
    async (_failure, managed, error, message, retryable) => {
      const loadPreview = vi.fn();
      if (managed) {
        vi.spyOn(githubIdentity, "prepareGitHubReadIdentity").mockRejectedValue(error);
      } else {
        loadPreview.mockRejectedValue(error);
      }
      const { respond, send } = fixture("githubPreview", loadPreview);
      await send(
        {
          kind: managed ? "issue" : "pull",
          number: managed ? 88125 : 99816,
          owner: "openclaw",
          repo: "openclaw",
          ...(managed ? { agentId: "main" } : {}),
        },
        managed
          ? runtime(() => ({
              ...configuredGitHub("existing-preview-service-token"),
              tools: { github: { profileId: `ghp_${"b".repeat(32)}` } },
            }))
          : {},
      );
      if (managed) {
        expect(loadPreview).not.toHaveBeenCalled();
      }
      expectError(respond, {
        code: "UNAVAILABLE",
        message,
        retryable,
      });
    },
  );
});

describe("controlUi.sessionPullRequests.subscribe", () => {
  it("reports subscription preparation failures without rejecting the request", async () => {
    const warn = vi.fn();
    const scheduler = createTestGatewayScheduler();
    const subscriptions = createControlUiSessionPullRequestSubscriptions({
      scheduler,
      broadcastToConnIds: vi.fn(),
      prepareRead: async () => {
        throw new Error("session reader unavailable");
      },
    });
    try {
      const { respond, send } = fixture("sessionPullRequests.subscribe");
      await send(
        { sessionKeys: ["agent:main:main"] },
        {
          client: { connId: "conn-control-ui" },
          context: {
            controlUiSessionPullRequests: subscriptions,
            logGateway: { warn },
          },
        },
      );
      expectReply(respond, { subscribed: true });
    } finally {
      await subscriptions.stop();
      await scheduler.stop();
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("session reader unavailable"));
  });

  it.each([
    {
      sessionKeys: [" agent:main:main ", "agent:main:main", "agent:work:main"],
      expected: ["agent:main:main", "agent:work:main"],
      subscribed: true,
      valid: true,
    },
    { sessionKeys: [], expected: [], subscribed: false, valid: true },
    { sessionKeys: [" "], expected: [], subscribed: false, valid: false },
  ])(
    "validates subscriptions: $sessionKeys",
    async ({ sessionKeys, expected, subscribed, valid }) => {
      const { promise: hydration, resolve: finishHydration } = createDeferred();
      const replace = valid
        ? vi.fn(
            (
              _connId: string,
              _sessionKeys: readonly string[],
              _refreshSessionKeys: ReadonlySet<string> | undefined,
              onAdmitted: (() => void) | undefined,
            ) => {
              onAdmitted?.();
              return hydration;
            },
          )
        : vi.fn();
      const { respond, send } = fixture("sessionPullRequests.subscribe", vi.fn());
      const request = send(
        { sessionKeys },
        {
          client: { connId: "conn-control-ui" },
          context: { controlUiSessionPullRequests: { replace } },
        },
      );
      if (!valid) {
        await request;
        expect(replace).not.toHaveBeenCalled();
        expectError(respond, {
          code: "INVALID_REQUEST",
          message: "invalid controlUi.sessionPullRequests.subscribe params",
        });
        return;
      }
      await Promise.resolve();
      expect(replace).toHaveBeenCalledWith(
        "conn-control-ui",
        expected,
        undefined,
        expect.any(Function),
        undefined,
      );
      expectReply(respond, { subscribed });
      finishHydration();
      await request;
    },
  );
});

describe("controlUi.sessionPullRequests.checks", () => {
  const params = {
    sessionKey: "agent:main:ci-details",
    owner: "openclaw",
    repo: "openclaw",
    number: 103469,
    headSha: "a".repeat(40),
  };
  const result = {
    owner: params.owner,
    repo: params.repo,
    number: params.number,
    headSha: params.headSha,
    checks: [],
    status: "ready" as const,
    rateLimited: false,
  };

  it.each([
    { ...params, headSha: "main" },
    { ...params, owner: "../other" },
    { ...params, number: -1 },
    { ...params, url: "https://github.com/other/repo" },
    { ...params, sessionKey: "" },
  ])("rejects malformed check params: %j", async (input) => {
    const load = vi.fn().mockResolvedValue(result);
    const { respond, send } = fixture("sessionPullRequests.checks", undefined, load);
    await send(input);
    expect(load).not.toHaveBeenCalled();
    expectError(respond, expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it.each(["missing session", "unavailable projection", "incognito", "draft"] as const)(
    "denies %s sessions before GitHub loading",
    async (mode) => {
      await withOpenClawTestState({ label: "ci-details-unavailable" }, async () => {
        setRuntimeConfigSnapshot({});
        const unprojected = mode === "unavailable projection";
        if (mode !== "missing session") {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: params.sessionKey },
            {
              sessionId: unprojected ? "unprojected-ci" : "hidden-ci",
              updatedAt: 1,
              createdActor: {
                type: "human",
                source: "profile",
                id: unprojected ? "viewer" : "owner",
              },
              ...(unprojected
                ? { visibility: "shared" as const }
                : mode === "incognito"
                  ? { incognito: true }
                  : { visibility: "draft" as const }),
            },
          );
        }
        const load = vi.fn().mockResolvedValue(result);
        const { respond, send } = fixture("sessionPullRequests.checks", undefined, load);
        await send(
          params,
          mode !== "missing session"
            ? { client: { ...identifiedClient("viewer"), connId: "viewer" } }
            : {},
        );
        expect(load).not.toHaveBeenCalled();
        expectUnavailable(respond);
      });
    },
  );

  it("rechecks session generation before delivery", async () => {
    await withOpenClawTestState({ label: "ci-details-generation" }, async () => {
      setRuntimeConfigSnapshot({});
      const session = {
        agentId: "main",
        sessionKey: params.sessionKey,
        sessionId: "ci-generation-one",
      };
      await replaceSessionEntry(session, {
        sessionId: session.sessionId,
        updatedAt: 1,
        spawnedCwd: "/synthetic/ci",
      });
      const deferred = createDeferred<typeof result>();
      const started = createDeferred();
      const load = vi.fn(async () => {
        started.resolve();
        return deferred.promise;
      });
      const { respond, send } = fixture("sessionPullRequests.checks", undefined, load);
      const request = send(params);
      await started.promise;
      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({ ...params, agentId: "main" }),
        expect.objectContaining({
          assertCurrent: expect.any(Function),
          sessionScope: expect.stringContaining("ci-generation-one"),
        }),
      );
      await replaceSessionEntry(session, {
        sessionId: "ci-generation-two",
        updatedAt: 2,
        spawnedCwd: "/synthetic/ci",
      });
      deferred.resolve(result);
      await request;
      expectError(
        respond,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: "Session changed; reopen CI details",
        }),
      );
    });
  });

  it.each(["before", "during"] as const)("enforces roles %s loading", async (when) => {
    await withOpenClawTestState({ label: "ci-details-missing-client-roles" }, async () => {
      let cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const enableRoles = () => {
        cfg = { ...cfg, gateway: { roles: { definitions: {} } } };
        setRuntimeConfigSnapshot(cfg);
      };
      setRuntimeConfigSnapshot(cfg);
      await replaceSessionEntry(
        { agentId: "main", sessionKey: params.sessionKey },
        { sessionId: "role-bound-ci", updatedAt: 1, spawnedCwd: "/synthetic/ci" },
      );
      if (when === "before") {
        enableRoles();
      }
      const load = vi.fn(async () => {
        enableRoles();
        return result;
      });
      const { respond, send } = fixture("sessionPullRequests.checks", undefined, load);
      await send(
        params,
        runtime(() => cfg),
      );
      expect(load).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
      expectUnavailable(respond);
    });
  });

  it("pins qualified global session ownership", async () => {
    await withOpenClawTestState({ label: "ci-details-global" }, async () => {
      const cfg: OpenClawConfig = {
        session: { scope: "global" },
        agents: { entries: { main: {}, research: {} } },
      };
      setRuntimeConfigSnapshot(cfg);
      await replaceSessionEntry(
        { agentId: "research", sessionKey: "global" },
        { sessionId: "research-ci", updatedAt: 1 },
      );
      const load = vi.fn().mockResolvedValue(result);
      const { respond, send } = fixture("sessionPullRequests.checks", undefined, load);
      await send(
        { ...params, sessionKey: "agent:research:main" },
        runtime(() => cfg),
      );
      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "research" }),
        expect.objectContaining({ sessionScope: expect.stringContaining("research-ci") }),
      );
      expectReply(respond, result);
    });
  });
});

describe("controlUi.linkPreview", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    { url: "http://127.0.0.1/private" },
    { url: "https://public.example", token: "not-forwarded" },
    {},
  ])("rejects malformed or private targets %j", async (params) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const { respond, send } = fixture("linkPreview");
    await send(params);
    expectError(respond, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["authority", "config", "principal"] as const)(
    "rechecks %s during fetch",
    async (change) => {
      let cfg: OpenClawConfig = { gateway: { port: 19010 } };
      setRuntimeConfigSnapshot(cfg);
      let current = true;
      const client = { ...identifiedClient("preview-reader"), connId: "preview-connection" };
      const started = createDeferred();
      const gate = createDeferred<Response>();
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        if ((input instanceof Request ? input.url : input.toString()).endsWith("/favicon.ico")) {
          return new Response(null, { status: 404 });
        }
        started.resolve();
        return gate.promise;
      });
      vi.stubGlobal("fetch", fetch);
      const { respond, send } = fixture("linkPreview");
      const pending = send(
        { url: `https://rpc-preview.example/retired-${change}` },
        {
          client,
          context: { getRuntimeConfig: () => cfg },
          hasCurrentClientAuthority: () => current,
        },
      );
      await started.promise;
      if (change === "authority") {
        current = false;
      } else if (change === "config") {
        cfg = { gateway: { port: 19011 } };
        setRuntimeConfigSnapshot(cfg);
      } else {
        client.authenticatedUserId = "another-reader";
      }
      gate.resolve(
        new Response("<head><title>Retired preview</title></head>", {
          headers: { "content-type": "text/html" },
        }),
      );
      await pending;
      expectReply(respond, {});
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])("honors automatic fetching: %s", async (enabled) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    if (enabled) {
      fetch.mockImplementation(async (input) =>
        (input instanceof Request ? input.url : input.toString()).endsWith("/favicon.ico")
          ? new Response(null, { status: 404 })
          : new Response('<head><meta property="og:title" content="Handler preview"></head>', {
              headers: { "content-type": "text/html" },
            }),
      );
    }
    vi.stubGlobal("fetch", fetch);
    const { respond, send } = fixture("linkPreview");
    await send(
      { url: enabled ? "https://rpc-preview.example/page" : "https://disabled.example/page" },
      enabled
        ? {}
        : runtime(() => ({
            gateway: { controlUi: { automaticallyFetchFavicons: false } },
          })),
    );
    expectReply(respond, enabled ? { title: "Handler preview" } : {});
    if (enabled) {
      expect(fetch).toHaveBeenCalledTimes(2);
    } else {
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});
