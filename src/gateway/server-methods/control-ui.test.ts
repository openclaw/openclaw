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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { gitHubPublicApi } from "../github-public-api.js";
import { createControlUiRequestOptions } from "./control-ui-request.test-support.js";
import { createControlUiHandlers } from "./control-ui.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

const requestOptions = createControlUiRequestOptions(() => ({
  agents: { entries: { main: {} } },
  gateway: { controlUi: { github: { token: "preview-service-token" } } },
}));

describe("controlUi.githubPreview", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    setActiveDegradedSecretOwners([]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(["revoked", "copied", "aborted", "aborted-after-preparation"] as const)(
    "rejects %s requests before reading GitHub",
    async (state) => {
      const client = { ...identifiedClient("preview-reader"), connId: "preview-connection" };
      const controller = new AbortController();
      if (state === "aborted") {
        controller.abort();
      }
      const loadPreview = vi.fn();
      const respond = vi.fn<RespondFn>();
      const handler = expectDefined(
        createControlUiHandlers(loadPreview)["controlUi.githubPreview"],
        "preview handler",
      );
      const pending = handler({
        ...requestOptions({ kind: "issue", number: 1, owner: "octocat", repo: "repo" }, respond, {
          client: state === "copied" ? { ...client } : client,
          context: {
            getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
            getClientConnIds: (filter: (current: GatewayClient) => boolean) =>
              new Set(filter(client) ? [client.connId] : []),
          },
        }),
        signal: controller.signal,
        ...(state === "revoked" ? { hasCurrentClientAuthority: () => false } : {}),
      });
      if (state === "aborted-after-preparation") {
        controller.abort();
      }
      await pending;
      expect(loadPreview).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "UNAVAILABLE",
        message: "GitHub request is no longer active. Try again.",
        retryable: true,
      });
    },
  );

  it.each([
    { mode: "managed", method: "controlUi.githubPreview" },
    { mode: "managed", method: "controlUi.githubDetail" },
    { mode: "service", method: "controlUi.githubDetail" },
    { mode: "anonymous", method: "controlUi.githubPreview" },
  ])("reads $method with its selected $mode credential", async ({ mode, method }) => {
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
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: {},
          ...(mode === "managed"
            ? { alternate: { tools: { github: { profileId: identity.selection.profileId } } } }
            : {}),
        },
      },
      ...(mode !== "anonymous"
        ? {
            gateway: {
              controlUi: {
                github: {
                  token:
                    mode === "managed" ? "old-preview-service-token" : "configured-reader-token",
                },
              },
            },
          }
        : {}),
    };
    if (mode !== "anonymous") {
      setRuntimeConfigSnapshot(cfg);
    }
    const title =
      mode === "managed" ? "Use the selected GitHub identity" : "Public metadata without a login";
    const anonymousResponse = new Response(
      JSON.stringify({
        created_at: "2026-09-01T08:00:00Z",
        updated_at: "2026-09-01T09:00:00Z",
        state: "open",
        title,
        user: { login: "octocat" },
      }),
    );
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
      return new Response(
        JSON.stringify(
          issue
            ? {
                created_at: mode === "service" ? "2026-09-20T08:00:00Z" : "2026-09-01T08:00:00Z",
                updated_at: mode === "service" ? "2026-09-20T09:00:00Z" : "2026-09-01T09:00:00Z",
                state: "open",
                title: mode === "service" ? "Authenticated reader" : title,
                user: { login: "octocat" },
                ...(mode === "managed"
                  ? { repository_url: "https://api.github.com/repos/openclaw/openclaw" }
                  : {}),
                body: mode === "managed" ? "Authenticated reader body" : "Reader body",
                comments: 0,
              }
            : { id: mode === "managed" ? 123 : 124, private: false, visibility: "public" },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      createControlUiHandlers()[method],
      "GitHub read handler",
    )(
      requestOptions(
        {
          kind: "issue",
          number: mode === "managed" ? 88120 : mode === "service" ? 1 : 88121,
          owner: mode === "service" ? "octocat" : "openclaw",
          repo: mode === "service" ? "reader-auth" : "openclaw",
          agentId: mode === "managed" ? "alternate" : "main",
        },
        respond,
        { context: { getRuntimeConfig: () => cfg } },
      ),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining(mode === "service" ? { body: "Reader body" } : { title }),
      undefined,
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
    "keeps public GitHub targets on their public API with Enterprise selected (%s)",
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
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        return new Response(
          JSON.stringify(
            url.includes("/issues/")
              ? {
                  created_at: "2026-09-01T08:00:00Z",
                  updated_at: "2026-09-01T09:00:00Z",
                  repository_url: "https://api.github.com/repos/openclaw/public-routing",
                  state: "open",
                  title: "Public issue",
                  body: "Public body",
                  comments: 0,
                  user: { login: "octocat" },
                }
              : { id: 125, private: false, visibility: "public" },
          ),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const respond = vi.fn<RespondFn>();
      await expectDefined(
        createControlUiHandlers()[method],
        "GitHub public read handler",
      )(
        requestOptions(
          { kind: "issue", number: 88121, owner: "openclaw", repo: "public-routing" },
          respond,
          { context: { getRuntimeConfig: () => cfg } },
        ),
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ title: "Public issue" }),
        undefined,
      );
      expect(fetchMock).toHaveBeenCalled();
      for (const [url, options] of fetchMock.mock.calls) {
        expect(url).toMatch(/^https:\/\/api.github.com\//);
        expect(new Headers(options?.headers).get("Authorization")).toBeNull();
      }
    },
  );

  it("revalidates configured credential availability before delivering a cached preview", async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: { controlUi: { github: { token: "configured-preview-token" } } },
    };
    setRuntimeConfigSnapshot(cfg);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      return new Response(
        JSON.stringify(
          url.includes("/issues/")
            ? {
                title: "Cached preview",
                state: "open",
                created_at: "2026-09-01T08:00:00Z",
                updated_at: "2026-09-01T09:00:00Z",
                repository_url: "https://api.github.com/repos/openclaw/configured-degraded",
                user: { login: "octocat" },
              }
            : { private: false, visibility: "public" },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = expectDefined(
      createControlUiHandlers()["controlUi.githubPreview"],
      "preview handler",
    );
    const respond = vi.fn<RespondFn>();
    const options = requestOptions(
      { kind: "issue", number: 70014, owner: "openclaw", repo: "configured-degraded" },
      respond,
      { context: { getRuntimeConfig: () => cfg } },
    );
    await handler(options);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ title: "Cached preview" }),
      undefined,
    );
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
    await handler(options);
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message:
        "The configured Control UI GitHub credential is unavailable. Check gateway.controlUi.github.token and its host binding, then retry.",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["agent", "system"])(
    "delivers public metadata only while its fallback identity remains selected: %s",
    async (selection) => {
      const preview = {
        comments: 4,
        createdAt: "2026-07-05T08:00:00Z",
        kind: "issue",
        login: "octocat",
        number: 99815,
        owner: "openclaw",
        repo: "openclaw",
        state: "open",
        title: "Keep hover previews compact",
        updatedAt: "2026-07-05T09:55:00Z",
      };
      let cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const started = createDeferred();
      const pending = createDeferred<typeof preview>();
      const loadPreview = vi.fn(() => {
        started.resolve();
        return pending.promise;
      });
      const handlers = createControlUiHandlers(loadPreview);
      const respond = vi.fn<RespondFn>();

      const request = expectDefined(
        handlers["controlUi.githubPreview"],
        'handlers["controlUi.githubPreview"] test invariant',
      )(
        requestOptions(
          { kind: "issue", number: 99815, owner: "openclaw", repo: "openclaw" },
          respond,
          { context: { getRuntimeConfig: () => cfg } },
        ),
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

      expect(loadPreview).toHaveBeenCalledWith(
        { kind: "issue", number: 99815, owner: "openclaw", repo: "openclaw" },
        undefined,
      );
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "UNAVAILABLE",
        message: new githubIdentity.GitHubIdentityError("changed").message,
        retryable: true,
      });
    },
  );

  it.each([
    { name: "explicit refresh", owner: "openclaw", refresh: true, valid: true },
    { name: "malformed refresh", owner: "openclaw", refresh: "true", valid: false },
    { name: "malformed owner", owner: "openclaw/evil", refresh: undefined, valid: false },
  ])("validates $name before loading GitHub", async ({ owner, refresh, valid }) => {
    const target = { kind: "issue", owner, repo: "openclaw", number: 99817 };
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
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      createControlUiHandlers(loadPreview)["controlUi.githubPreview"],
      "preview handler",
    )(requestOptions({ ...target, ...(refresh !== undefined ? { refresh } : {}) }, respond));
    if (valid) {
      expect(loadPreview).toHaveBeenCalledExactlyOnceWith(target, undefined, undefined, true);
      expect(respond).toHaveBeenCalledWith(true, preview, undefined);
    } else {
      expect(loadPreview).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "INVALID_REQUEST",
        message: "invalid controlUi.githubPreview params",
      });
    }
  });

  it.each([
    {
      failure: "managed identity unavailable",
      managed: true,
      error: new githubIdentity.GitHubIdentityError("unavailable"),
      message:
        "The selected GitHub credential is unavailable; reconnect the agent's GitHub identity in Settings.",
      retryable: false,
    },
    {
      failure: "GitHub quota",
      managed: false,
      error: new gitHubPublicApi.ControlUiGitHubError(429, "rate limited"),
      message: "GitHub API rate limit exceeded (HTTP 429). Wait and retry.",
      retryable: true,
    },
    {
      failure: "configured-unavailable preview credential",
      managed: false,
      error: new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        paths: ["gateway.controlUi.github.token"],
        refKeys: [],
        reason: "secret reference was not found",
      }),
      message:
        "The configured Control UI GitHub credential is unavailable. Check gateway.controlUi.github.token and its host binding, then retry.",
      retryable: false,
    },
  ])(
    "preserves the $failure diagnostic in the RPC response",
    async ({ error, message, retryable, managed }) => {
      const loadPreview = vi.fn();
      if (managed) {
        vi.spyOn(githubIdentity, "prepareGitHubReadIdentity").mockRejectedValue(error);
      } else {
        loadPreview.mockRejectedValue(error);
      }
      const handlers = createControlUiHandlers(loadPreview);
      const respond = vi.fn<RespondFn>();

      await expectDefined(
        handlers["controlUi.githubPreview"],
        'handlers["controlUi.githubPreview"] test invariant',
      )(
        requestOptions(
          {
            kind: managed ? "issue" : "pull",
            number: managed ? 88125 : 99816,
            owner: "openclaw",
            repo: "openclaw",
            ...(managed ? { agentId: "main" } : {}),
          },
          respond,
          managed
            ? {
                context: {
                  getRuntimeConfig: () => ({
                    agents: { entries: { main: {} } },
                    tools: { github: { profileId: `ghp_${"b".repeat(32)}` } },
                    gateway: { controlUi: { github: { token: "existing-preview-service-token" } } },
                  }),
                },
              }
            : {},
        ),
      );
      if (managed) {
        expect(loadPreview).not.toHaveBeenCalled();
      }
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "UNAVAILABLE",
        message,
        retryable,
      });
    },
  );
});

describe("controlUi.sessionPullRequests.subscribe", () => {
  it.each([
    {
      sessionKeys: [" agent:main:main ", "agent:main:main", "agent:work:main"],
      expected: ["agent:main:main", "agent:work:main"],
      subscribed: true,
    },
    { sessionKeys: [], expected: [], subscribed: false },
  ])(
    "acknowledges the normalized replacement before hydration: $subscribed",
    async ({ sessionKeys, expected, subscribed }) => {
      const { promise: hydration, resolve: finishHydration } = createDeferred();
      const replace = vi.fn(
        (
          _connId: string,
          _sessionKeys: readonly string[],
          _refreshSessionKeys: ReadonlySet<string> | undefined,
          onAdmitted: (() => void) | undefined,
        ) => {
          onAdmitted?.();
          return hydration;
        },
      );
      const respond = vi.fn<RespondFn>();
      const request = expectDefined(
        createControlUiHandlers(vi.fn())["controlUi.sessionPullRequests.subscribe"],
        "subscription handler",
      )(
        requestOptions({ sessionKeys }, respond, {
          client: { connId: "conn-control-ui" },
          context: { controlUiSessionPullRequests: { replace } },
        }),
      );
      await Promise.resolve();
      expect(replace).toHaveBeenCalledWith(
        "conn-control-ui",
        expected,
        undefined,
        expect.any(Function),
      );
      expect(respond).toHaveBeenCalledWith(true, { subscribed }, undefined);
      finishHydration();
      await request;
    },
  );

  it("rejects malformed replace-sets", async () => {
    const replace = vi.fn();
    const handlers = createControlUiHandlers(vi.fn());
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions({ sessionKeys: [" "] }, respond, {
        client: { connId: "conn-control-ui" },
        context: { controlUiSessionPullRequests: { replace } },
      }),
    );

    expect(replace).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.sessionPullRequests.subscribe params",
    });
  });
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
  ])("rejects invalid or client-URL parameters before loading: %j", async (input) => {
    const load = vi.fn().mockResolvedValue(result);
    const handler = expectDefined(
      createControlUiHandlers(undefined, undefined, load)["controlUi.sessionPullRequests.checks"],
      "CI checks handler",
    );
    const respond = vi.fn<RespondFn>();
    await handler(requestOptions(input, respond));
    expect(load).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it.each(["missing session", "unavailable projection"])(
    "rejects a %s without invoking the GitHub loader",
    async (missing) => {
      await withOpenClawTestState({ label: "ci-details-unavailable" }, async () => {
        if (missing === "unavailable projection") {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: params.sessionKey },
            {
              sessionId: "unprojected-ci",
              updatedAt: 1,
              visibility: "shared",
              createdActor: { type: "human", source: "profile", id: "viewer" },
            },
          );
        }
        const load = vi.fn().mockResolvedValue(result);
        const handler = expectDefined(
          createControlUiHandlers(undefined, undefined, load)[
            "controlUi.sessionPullRequests.checks"
          ],
          "CI checks handler",
        );
        const respond = vi.fn<RespondFn>();
        await handler({
          ...requestOptions(params, respond),
          ...(missing === "unavailable projection" ? { client: identifiedClient("viewer") } : {}),
        });
        expect(load).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
      });
    },
  );

  it("binds the visible session generation and rechecks it before returning details", async () => {
    await withOpenClawTestState({ label: "ci-details-generation" }, async () => {
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
      const handler = expectDefined(
        createControlUiHandlers(undefined, undefined, load)["controlUi.sessionPullRequests.checks"],
        "CI checks handler",
      );
      const respond = vi.fn<RespondFn>();
      const request = handler(requestOptions(params, respond));
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
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: "Session changed; reopen CI details",
        }),
      );
    });
  });

  it.each([{ incognito: true as const }, { visibility: "draft" as const }])(
    "does not expose a hidden session to another profile: %j",
    async (hidden) => {
      await withOpenClawTestState({ label: "ci-details-hidden" }, async () => {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: params.sessionKey },
          {
            sessionId: "hidden-ci",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: "owner" },
            ...hidden,
          },
        );
        const load = vi.fn().mockResolvedValue(result);
        const handler = expectDefined(
          createControlUiHandlers(undefined, undefined, load)[
            "controlUi.sessionPullRequests.checks"
          ],
          "CI checks handler",
        );
        const respond = vi.fn<RespondFn>();
        await handler({ ...requestOptions(params, respond), client: identifiedClient("viewer") });
        expect(load).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
      });
    },
  );

  it("keeps qualified global sessions bound to their resolved agent", async () => {
    await withOpenClawTestState({ label: "ci-details-global" }, async () => {
      const cfg: OpenClawConfig = {
        session: { scope: "global" },
        agents: { entries: { main: { default: true }, research: {} } },
      };
      await replaceSessionEntry(
        { agentId: "research", sessionKey: "global" },
        { sessionId: "research-ci", updatedAt: 1 },
      );
      const load = vi.fn().mockResolvedValue(result);
      const handler = expectDefined(
        createControlUiHandlers(undefined, undefined, load)["controlUi.sessionPullRequests.checks"],
        "CI checks handler",
      );
      const respond = vi.fn<RespondFn>();
      await handler(
        requestOptions({ ...params, sessionKey: "agent:research:main" }, respond, {
          context: { getRuntimeConfig: () => cfg },
        }),
      );
      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "research" }),
        expect.objectContaining({ sessionScope: expect.stringContaining("research-ci") }),
      );
      expect(respond).toHaveBeenCalledWith(true, result, undefined);
    });
  });
});

describe("controlUi.linkPreview", () => {
  afterEach(() => {
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
    const respond = vi.fn();
    await createControlUiHandlers()["controlUi.linkPreview"]!(requestOptions(params, respond));
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "projects public metadata only when fetching is enabled: %s",
    async (enabled) => {
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
      const respond = vi.fn();
      await createControlUiHandlers()["controlUi.linkPreview"]!(
        requestOptions(
          { url: enabled ? "https://rpc-preview.example/page" : "https://disabled.example/page" },
          respond,
          enabled
            ? {}
            : {
                context: {
                  getRuntimeConfig: () => ({
                    gateway: { controlUi: { automaticallyFetchFavicons: false } },
                  }),
                },
              },
        ),
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        enabled ? { title: "Handler preview" } : {},
        undefined,
      );
      if (enabled) {
        expect(fetch).toHaveBeenCalledTimes(2);
      } else {
        expect(fetch).not.toHaveBeenCalled();
      }
    },
  );
});
