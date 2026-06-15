/**
 * Tests agent id resolution and roster validation for gateway OpenAI-compatible requests.
 */
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const loadConfigMock = vi.fn();

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

import { resolveAgentIdForRequest } from "./http-utils.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

function createConfig(agentIds: string[]): OpenClawConfig {
  return {
    agents: {
      list: agentIds.map((id) => ({ id })),
      defaults: {
        model: { primary: "openai/gpt-5.4" },
      },
    },
  } satisfies OpenClawConfig;
}

describe("resolveAgentIdForRequest", () => {
  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue(createConfig(["main", "beta"]));
  });

  it("resolves to the default agent when no explicit target is provided", () => {
    const result = resolveAgentIdForRequest({ req: createReq(), model: undefined });
    expect(result).toEqual({ agentId: "main" });
  });

  it("resolves openclaw/default to the default agent", () => {
    const result = resolveAgentIdForRequest({ req: createReq(), model: "openclaw/default" });
    expect(result).toEqual({ agentId: "main" });
  });

  it("resolves openclaw to the default agent", () => {
    const result = resolveAgentIdForRequest({ req: createReq(), model: "openclaw" });
    expect(result).toEqual({ agentId: "main" });
  });

  it("resolves a known agent from the model field", () => {
    const result = resolveAgentIdForRequest({ req: createReq(), model: "openclaw/beta" });
    expect(result).toEqual({ agentId: "beta" });
  });

  it("returns an error for an unknown agent in the model field", () => {
    const result = resolveAgentIdForRequest({ req: createReq(), model: "openclaw/unknown" });
    expect(result).toEqual({ error: { status: 404, message: "Unknown agent 'unknown'." } });
  });

  it("resolves a known agent from the x-openclaw-agent-id header", () => {
    const result = resolveAgentIdForRequest({
      req: createReq({ "x-openclaw-agent-id": "beta" }),
      model: "openclaw",
    });
    expect(result).toEqual({ agentId: "beta" });
  });

  it("returns an error for an unknown agent in the x-openclaw-agent-id header", () => {
    const result = resolveAgentIdForRequest({
      req: createReq({ "x-openclaw-agent-id": "unknown" }),
      model: "openclaw",
    });
    expect(result).toEqual({ error: { status: 404, message: "Unknown agent 'unknown'." } });
  });

  it("returns an error for an unknown agent in the x-openclaw-agent header", () => {
    const result = resolveAgentIdForRequest({
      req: createReq({ "x-openclaw-agent": "unknown" }),
      model: "openclaw",
    });
    expect(result).toEqual({ error: { status: 404, message: "Unknown agent 'unknown'." } });
  });

  it("prioritizes the header over the model field", () => {
    const result = resolveAgentIdForRequest({
      req: createReq({ "x-openclaw-agent-id": "beta" }),
      model: "openclaw/main",
    });
    expect(result).toEqual({ agentId: "beta" });
  });
});
