import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  SecretSurfaceUnavailableError,
  setActiveDegradedSecretOwners,
} from "../../secrets/runtime-degraded-state.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  startTestRepositorySessionPresentation,
  createTestRepositorySessionPresentation,
} from "../github-account-service.test-support.js";
import {
  readGitHubConfig,
  loadGitHubRepositoryRuntimeFixture,
} from "../github-repository-fixture-api.test-support.js";
import { gitHubAccountApi } from "../native-github-account-api.js";
import { githubApiToken } from "../native-github-service-credential.js";
import type { RepositorySessionPresentation } from "../repository-session-read.types.js";
import {
  createControlUiRequestOptions,
  controlUiIssueFields as issueFields,
  controlUiJson as json,
  mockControlUiGitHubFetch as mockGitHubFetch,
  type PreparedPreviewIdentity,
  type PreviewIdentityPreparation,
  controlUiGitHubConfig as configuredGitHub,
  expectControlUiReply as expectReply,
  expectControlUiError as expectError,
  expectControlUiUnavailable as expectUnavailable,
} from "./control-ui-request.test-support.js";
import { controlUiHandlers as coreControlUiHandlers } from "./control-ui.js";
import { identifiedClient, soloClient } from "./sessions-sharing.test-support.js";
import type { GatewayClient, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const { controlUiGitHubHandlers } = await loadGitHubRepositoryRuntimeFixture();
const { gitHubPublicApi } = await loadBundledPluginFacade<{
  gitHubPublicApi: Pick<typeof gitHubAccountApi, "ControlUiGitHubError"> & {
    loadControlUiGitHubPreview(
      target: { kind: "issue" | "pull"; owner: string; repo: string; number: number },
      identity?: Pick<PreparedPreviewIdentity, "cacheScope" | "revalidate" | "assertSelected"> & {
        token?: string;
        signal?: AbortSignal;
        optionalAuth?: true;
      },
      fetchImpl?: typeof fetch,
      refresh?: boolean,
      request?: { signal: AbortSignal; assertActive: () => void },
    ): Promise<unknown>;
  };
}>({ pluginId: "github-repositories", artifactBasename: "public-api.js" });
const githubIdentity = await loadBundledPluginFacade<{
  prepareGitHubReadIdentity(input: PreviewIdentityPreparation): Promise<PreparedPreviewIdentity>;
  GitHubIdentityError: new (
    reason: "unavailable" | "changed" | "rate_limited" | "unverified",
  ) => Error;
}>({ pluginId: "github-repositories", artifactBasename: "tool-identity-api.js" });

const controlUiHandlers = { ...coreControlUiHandlers, ...controlUiGitHubHandlers };

const requestOptions = createControlUiRequestOptions(() =>
  configuredGitHub("preview-service-token"),
);

type RequestExtras = Parameters<typeof requestOptions>[2] &
  Pick<Partial<GatewayRequestHandlerOptions>, "signal" | "hasCurrentClientAuthority">;
function fixture(method: string, checks?: RepositorySessionPresentation["checks"]) {
  const handler = expectDefined(controlUiHandlers[`controlUi.${method}`], method);
  const respond = vi.fn<RespondFn>();
  return {
    respond,
    send: async (params: Record<string, unknown>, extra?: RequestExtras) => {
      const options: GatewayRequestHandlerOptions = {
        ...requestOptions(params, respond, extra),
        signal: extra?.signal,
        hasCurrentClientAuthority: extra?.hasCurrentClientAuthority,
      };
      const invoke = () =>
        withPluginRuntimeGatewayRequestScope(
          {
            context: options.context,
            client: options.client,
            signal: options.signal,
            hasCurrentClientAuthority:
              options.hasCurrentClientAuthority ?? (() => !options.client?.invalidated),
            isWebchatConnect: options.isWebchatConnect,
          },
          () => handler(options),
        );
      if (method !== "sessionPullRequests.checks" || options.context.repositorySessions) {
        return await invoke();
      }
      const scheduler = createTestGatewayScheduler();
      const services = await startTestRepositorySessionPresentation(
        options.context,
        scheduler,
        options.client ?? undefined,
        { cleanupOnFinish: false },
      );
      try {
        if (checks) {
          const presentation = expectDefined(
            options.context.resolveGatewayContext?.()?.repositorySessions?.presentation,
            "registered repository presentation",
          );
          vi.spyOn(presentation, "checks").mockImplementation(checks);
        }
        return await invoke();
      } finally {
        vi.restoreAllMocks();
        await services.stop({ strict: true });
        await scheduler.stop();
      }
    },
  };
}

function runtime(getRuntimeConfig: () => OpenClawConfig) {
  return { context: { getRuntimeConfig } };
}

function githubTarget(number: number, repo = "openclaw", owner = "openclaw") {
  return { kind: "issue", number, owner, repo };
}

const previewUnavailable =
  "The configured Control UI GitHub credential is unavailable. Check plugins.entries.github-repositories.config.service.token and its host binding, then retry.";

afterEach(() => vi.restoreAllMocks());

describe("controlUi.githubPreview", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    setActiveDegradedSecretOwners([]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns a progressive detail overview without loading optional endpoints", async () => {
    const cfg = configuredGitHub("progressive-service-token");
    setRuntimeConfigSnapshot(cfg);
    const revision = "a".repeat(40);
    const optional = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith("/pulls/7")) {
          return json(
            issueFields("Early body", {
              body: "Available before CI",
              comments: 1,
              review_comments: 1,
              changed_files: 1,
              head: { sha: revision },
            }),
          );
        }
        if (path.endsWith("/progressive-adapter")) {
          return Response.json({ id: 771, private: false, visibility: "public" });
        }
        optional();
        return new Response(null, { status: 503 });
      }),
    );
    const { respond, send } = fixture("githubDetail");
    await send(
      {
        kind: "pull",
        owner: "octocat",
        repo: "progressive-adapter",
        number: 7,
        section: "overview",
      },
      runtime(() => cfg),
    );
    expectReply(
      respond,
      expect.objectContaining({
        title: "Early body",
        body: "Available before CI",
        revision,
        deferredSections: ["checks", "files", "discussion"],
        partial: false,
      }),
    );
    expect(optional).not.toHaveBeenCalled();
    for (const field of ["checks", "comments", "files"]) {
      expect(respond.mock.calls[0]?.[1]).not.toHaveProperty(field);
    }
  });

  it.each(["invalid", null, 1])(
    "rejects invalid detail section %j before upstream access",
    async (section) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal("fetch", fetch);
      const { respond, send } = fixture("githubDetail");
      await send({ kind: "issue", owner: "octocat", repo: "repo", number: 1, section });
      expectError(respond, {
        code: "INVALID_REQUEST",
        message: "invalid controlUi.githubDetail params",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["revoked", "copied", "aborted", "aborted-after-preparation"] as const)(
    "rejects %s requests before GitHub",
    async (state) => {
      const client = { ...identifiedClient("preview-reader"), connId: "preview-connection" };
      const controller = new AbortController();
      if (state === "aborted") {
        controller.abort();
      }
      const loadPreview = vi.spyOn(gitHubPublicApi, "loadControlUiGitHubPreview");
      const { respond, send } = fixture("githubPreview");
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
      cfg.agents = { entries: { main: {}, alternate: {} } };
      const plugin = cfg.plugins!.entries!["github-repositories"]!.config!;
      plugin.agents = { alternate: { profileId: identity.selection.profileId } };
    }
    if (mode !== "anonymous") {
      setRuntimeConfigSnapshot(cfg);
    }
    const title =
      mode === "managed" ? "Use the selected GitHub identity" : "Public metadata without a login";
    const anonymousResponse = json(issueFields(title));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (mode === "anonymous") {
        return anonymousResponse;
      }
      const url = input instanceof Request ? input.url : input.toString();
      const issue = mode === "managed" ? url.endsWith("/issues/88120") : url.includes("/issues/");
      return json(
        issue
          ? issueFields(mode === "service" ? "Authenticated reader" : title, {
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
          controlUi: {},
        },
        plugins: {
          entries: {
            "github-repositories": {
              config: {
                host: "ghe.example.test",
                apiBaseUrl: "https://ghe.example.test/api/v3",
                service: { host: "ghe.example.test", token: "synthetic-enterprise-service" },
              },
            },
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
        ownerId: "plugins.entries.github-repositories.config.service.token",
        state: "unavailable",
        degradationState: "cold",
        reason: "secret reference was not found",
        paths: ["plugins.entries.github-repositories.config.service.token"],
        refKeys: ["store:default:PREVIEW_TOKEN"],
      },
    ]);
    expect(githubApiToken({ GH_TOKEN: "ambient" }, {})).toBe("ambient");
    respond.mockClear();
    await send(
      target,
      runtime(() => cfg),
    );
    expectError(respond, {
      code: "UNAVAILABLE",
      message:
        "The configured Control UI GitHub credential is unavailable. Check plugins.entries.github-repositories.config.service.token and its host binding, then retry.",
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
      vi.spyOn(gitHubPublicApi, "loadControlUiGitHubPreview").mockImplementation(() => {
        started.resolve();
        return pending.promise;
      });
      const { respond, send } = fixture("githubPreview");
      const request = send(
        githubTarget(99815),
        runtime(() => cfg),
      );
      await started.promise;
      const replacement = { profileId: `ghp_${"c".repeat(32)}` };
      cfg = {
        ...cfg,
        plugins: {
          entries: {
            "github-repositories": {
              config:
                selection === "agent" ? { agents: { main: replacement } } : { system: replacement },
            },
          },
        },
      };
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
    const preview = { title: "Refreshed preview" };
    const loadPreview = vi
      .spyOn(gitHubPublicApi, "loadControlUiGitHubPreview")
      .mockResolvedValue(preview);
    const { respond, send } = fixture("githubPreview");
    await send({ ...target, ...(refresh !== undefined ? { refresh } : {}) });
    if (valid) {
      expect(loadPreview).toHaveBeenCalledExactlyOnceWith(target, undefined, undefined, true);
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
    {
      failure: "configured-unavailable preview credential",
      managed: false,
      error: new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "plugins.entries.github-repositories.config.service.token",
        state: "unavailable",
        paths: ["plugins.entries.github-repositories.config.service.token"],
        refKeys: [],
        reason: "secret reference was not found",
      }),
      message: previewUnavailable,
      retryable: false,
    },
    ...(["unavailable", "unverified", "rate_limited"] as const).map((reason) => ({
      failure: `managed identity ${reason}`,
      managed: true,
      error: new githubIdentity.GitHubIdentityError(reason),
      message:
        reason === "unavailable"
          ? "The selected GitHub credential is unavailable; reconnect the agent's GitHub identity in Settings."
          : new githubIdentity.GitHubIdentityError(reason).message,
      retryable: false,
    })),
    {
      failure: "GitHub quota",
      managed: false,
      error: new gitHubPublicApi.ControlUiGitHubError(429, "rate limited"),
      message: "GitHub API rate limit exceeded (HTTP 429). Wait and retry.",
      retryable: true,
    },
  ])("preserves the $failure diagnostic", async ({ managed, error, message, retryable }) => {
    const loadPreview = vi.spyOn(gitHubPublicApi, "loadControlUiGitHubPreview");
    if (managed) {
      vi.spyOn(githubIdentity, "prepareGitHubReadIdentity").mockRejectedValue(error);
    } else {
      loadPreview.mockRejectedValue(error);
    }
    const { respond, send } = fixture("githubPreview");
    await send(
      {
        ...githubTarget(managed ? 88125 : 99816),
        kind: managed ? "issue" : "pull",
        ...(managed ? { agentId: "main" } : {}),
      },
      managed
        ? runtime(() => ({
            ...configuredGitHub("existing-preview-service-token"),
            plugins: {
              entries: {
                "github-repositories": {
                  config: {
                    ...readGitHubConfig(configuredGitHub("existing-preview-service-token")),
                    system: { profileId: `ghp_${"b".repeat(32)}` },
                  },
                },
              },
            },
          }))
        : {},
    );
    if (managed) {
      expect(loadPreview).not.toHaveBeenCalled();
    }
    expectError(respond, { code: "UNAVAILABLE", message, retryable });
  });
});

describe("controlUi.sessionPullRequests.subscribe", () => {
  it("acknowledges pending replacement and forwards later sidebar membership independently", async () => {
    const held = createDeferred();
    const preparing = createDeferred();
    const scheduler = createTestGatewayScheduler();
    const replace = vi.fn<Parameters<typeof createTestRepositorySessionPresentation>[2]>(
      async (_connId, _sessions, _refresh, admitted) => {
        preparing.resolve();
        admitted?.();
        await held.promise;
      },
    );
    const client = { ...soloClient(), connId: "conn-control-ui" };
    const service = await createTestRepositorySessionPresentation(scheduler, client, replace);
    const { respond, send } = fixture("sessionPullRequests.subscribe");
    const request = send(
      { sessionKeys: ["agent:main:main"], refreshSessionKeys: ["agent:main:main"] },
      { client, context: service.context },
    );
    try {
      await awaitGateBeforeSettlement(
        preparing.promise,
        request,
        "Subscription replacement did not start",
      );
      await request;
      expectReply(respond, { subscribed: true });
      await send(
        { sessionKeys: ["agent:main:main"], passiveSessionKeys: ["agent:main:sidebar"] },
        { client, context: service.context },
      );
      expect(respond).toHaveBeenCalledTimes(2);
      expect(replace).toHaveBeenNthCalledWith(
        1,
        client.connId,
        ["agent:main:main"],
        new Set(["agent:main:main"]),
        expect.any(Function),
        undefined,
      );
      expect(replace).toHaveBeenNthCalledWith(
        2,
        client.connId,
        ["agent:main:main"],
        undefined,
        expect.any(Function),
        new Set(["agent:main:sidebar"]),
      );
    } finally {
      held.resolve();
      await request;
      await Promise.all(replace.mock.results.map((result) => result.value));
      vi.restoreAllMocks();
      await service.stop();
      await scheduler.stop();
    }
  });

  it("reports subscription preparation failures without rejecting the request", async () => {
    const warn = vi.fn();
    const scheduler = createTestGatewayScheduler();
    const replace = vi.fn<Parameters<typeof createTestRepositorySessionPresentation>[2]>(
      async (_connId, _sessions, _refresh, admitted) => {
        admitted?.();
        throw new Error("session reader unavailable");
      },
    );
    const client = { ...soloClient(), connId: "conn-control-ui" };
    const service = await createTestRepositorySessionPresentation(scheduler, client, replace);
    service.context.logGateway.warn = warn;
    try {
      const { respond, send } = fixture("sessionPullRequests.subscribe");
      await send({ sessionKeys: ["agent:main:main"] }, { client, context: service.context });
      expectReply(respond, { subscribed: true });
    } finally {
      vi.restoreAllMocks();
      await service.stop();
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
      const admitted = createDeferred();
      const replace = vi.fn<Parameters<typeof createTestRepositorySessionPresentation>[2]>(
        async (_connId, _keys, _refresh, onAdmitted) => {
          onAdmitted?.();
          admitted.resolve();
          await hydration;
        },
      );
      const scheduler = createTestGatewayScheduler();
      const client = { ...soloClient(), connId: "conn-control-ui" };
      const service = await createTestRepositorySessionPresentation(scheduler, client, replace);
      const { respond, send } = fixture("sessionPullRequests.subscribe");
      const request = send(
        { sessionKeys },
        {
          client,
          context: service.context,
        },
      );
      try {
        if (!valid) {
          await request;
          expect(replace).not.toHaveBeenCalled();
          expectError(respond, {
            code: "INVALID_REQUEST",
            message: "invalid controlUi.sessionPullRequests.subscribe params",
          });
          return;
        }
        await awaitGateBeforeSettlement(
          admitted.promise,
          request,
          "Subscription request completed without admission",
        );
        expect(replace).toHaveBeenCalledWith(
          "conn-control-ui",
          expected,
          undefined,
          expect.any(Function),
          undefined,
        );
        expectReply(respond, { subscribed });
      } finally {
        finishHydration();
        await request;
        await Promise.all(replace.mock.results.map((result) => result.value));
        vi.restoreAllMocks();
        await service.stop();
        await scheduler.stop();
      }
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
    const load = vi.fn<RepositorySessionPresentation["checks"]>().mockResolvedValue(result);
    const { respond, send } = fixture("sessionPullRequests.checks", load);
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
        const load = vi.fn<RepositorySessionPresentation["checks"]>().mockResolvedValue(result);
        const { respond, send } = fixture("sessionPullRequests.checks", load);
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
      const load = vi.fn<RepositorySessionPresentation["checks"]>().mockImplementation(async () => {
        started.resolve();
        return deferred.promise;
      });
      const { respond, send } = fixture("sessionPullRequests.checks", load);
      const request = send(params);
      await started.promise;
      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            agentId: "main",
            sessionKey: params.sessionKey,
            sessionId: "ci-generation-one",
          }),
        }),
        params,
        expect.any(Function),
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
      const load = vi.fn<RepositorySessionPresentation["checks"]>().mockImplementation(async () => {
        enableRoles();
        return result;
      });
      const { respond, send } = fixture("sessionPullRequests.checks", load);
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
      const load = vi.fn<RepositorySessionPresentation["checks"]>().mockResolvedValue(result);
      const { respond, send } = fixture("sessionPullRequests.checks", load);
      await send(
        { ...params, sessionKey: "agent:research:main" },
        runtime(() => cfg),
      );
      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({ agentId: "research", sessionId: "research-ci" }),
        }),
        expect.objectContaining({
          owner: params.owner,
          repo: params.repo,
          number: params.number,
          headSha: params.headSha,
        }),
        expect.any(Function),
      );
      expectReply(respond, result);
    });
  });
});

describe("controlUi.linkPreview", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.unstubAllGlobals();
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
