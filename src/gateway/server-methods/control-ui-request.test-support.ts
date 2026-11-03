import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { RespondFn } from "./types.js";

export function createControlUiRequestOptions(getRuntimeConfig: () => OpenClawConfig) {
  return function requestOptions(
    params: Record<string, unknown>,
    respond: RespondFn,
    overrides: { client?: { connId: string }; context?: unknown } = {},
  ) {
    return {
      // SAFETY: Isolated handler fixtures provide only the client fields consumed by their route.
      client: (overrides.client ?? null) as never,
      // SAFETY: Each handler fixture supplies its route's context dependencies.
      context: (overrides.context ?? { getRuntimeConfig }) as never,
      isWebchatConnect: () => false,
      params,
      req: { id: "1", method: "controlUi.githubPreview", params, type: "req" as const },
      respond,
    };
  };
}

export function controlUiGitHubConfig(token: string): OpenClawConfig {
  return {
    agents: { entries: { main: {} } },
    gateway: {
      controlUi: {},
    },
    plugins: {
      entries: {
        "github-repositories": {
          config: {
            service: { token },
          },
        },
      },
    },
  };
}

export function expectControlUiReply(respond: RespondFn, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

export function expectControlUiError(respond: RespondFn, error: unknown) {
  expect(respond).toHaveBeenCalledWith(false, undefined, error);
}

export function expectControlUiUnavailable(respond: RespondFn) {
  expectControlUiError(respond, expect.objectContaining({ code: "UNAVAILABLE" }));
}

export type PreparedPreviewIdentity = {
  token: string;
  selection: {
    source: "system-detected" | "system-configured" | "agent-override";
    profileId?: string;
    accountId: number;
  };
  cacheScope: string;
  stale?: true;
  revoke?: () => Promise<void>;
  assertSelected: () => void;
  revalidate: () => Promise<void>;
  start: <T>(operation: () => T) => Promise<Awaited<T>>;
};
export type PreviewIdentityPreparation = {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  readNativeCredential?: import("../../agents/github-credential-reader.js").GitHubCredentialReader;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  issuer?: "github.com";
  allowAppInstallation?: boolean;
  requestedRepository?: string;
  allowStale?: boolean;
  getCurrentConfig: () => OpenClawConfig;
  assertActive: () => void;
  startActive?: PreparedPreviewIdentity["start"];
  refresh: () => Promise<void>;
};
export const controlUiJson = (value: unknown) => new Response(JSON.stringify(value));

export function controlUiIssueFields(title: string, extra: Record<string, unknown> = {}) {
  return {
    created_at: "2026-09-01T08:00:00Z",
    updated_at: "2026-09-01T09:00:00Z",
    state: "open",
    title,
    user: { login: "octocat" },
    ...extra,
  };
}

export function mockControlUiGitHubFetch(
  issue: Record<string, unknown>,
  repository: Record<string, unknown>,
) {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    controlUiJson(
      (input instanceof Request ? input.url : input.toString()).includes("/issues/")
        ? issue
        : repository,
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
