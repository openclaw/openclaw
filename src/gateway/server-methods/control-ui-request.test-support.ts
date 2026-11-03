import { expect } from "vitest";
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
