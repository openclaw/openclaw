/**
 * Tests HTTP request context extraction for gateway auth and routing.
 */
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import {
  authorizeOpenAiCompatibleHttpModelOverride,
  resolveGatewayRequestContext,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";

const sessionEntries = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const runtimeConfig = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    resolveSessionEntryAccessTarget: (params: { sessionKey: string }) => ({
      entry: sessionEntries.get(params.sessionKey),
    }),
  };
});

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => runtimeConfig.value,
}));

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

const sharedSecretRequestAuth = { trustDeclaredOperatorScopes: false };
const trustedRequestAuth = { trustDeclaredOperatorScopes: true };

beforeEach(() => {
  sessionEntries.clear();
  runtimeConfig.value = {};
});

describe("resolveGatewayRequestContext", () => {
  it("uses normalized x-openclaw-message-channel", () => {
    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-message-channel": " Custom-Channel " }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.messageChannel).toBe("custom-channel");
  });

  it("includes session prefix and user in generated session key", () => {
    const result = resolveGatewayRequestContext({
      req: createReq(),
      model: "openclaw",
      user: "alice",
      sessionPrefix: "openresponses",
    });

    expect(result.sessionKey).toContain("openresponses-user:alice");
  });

  it.each([
    "subagent:worker",
    "cron:daily",
    "acp:run-1",
    "harness:codex:supervision:native-thread",
    "agent:main:subagent:worker",
    "agent:main:cron:daily",
    "agent:main:acp:run-1",
    "agent:main:harness:codex:supervision:native-thread",
  ])("rejects reserved internal session-key override %s", (sessionKey) => {
    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-session-key": sessionKey }),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).toThrow(/reserved internal session namespaces/u);
  });

  it("preserves an existing unlocked legacy harness-prefixed override", () => {
    const sessionKey = "agent:main:harness:legacy-notes";
    sessionEntries.set(sessionKey, { sessionId: "legacy-session", modelSelectionLocked: false });

    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-session-key": sessionKey }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.sessionKey).toBe(sessionKey);
  });

  it("rejects an existing locked harness-prefixed override", () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    sessionEntries.set(sessionKey, {
      sessionId: "locked-session",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });

    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-session-key": sessionKey }),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).toThrow(/reserved internal session namespaces/u);
  });

  it("lets a valid agent header win over an unknown agent-specific model", () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-agent-id": "scripts" }),
      model: "openclaw/missing-agent",
      sessionPrefix: "openai",
    });

    expect(result.agentId).toBe("scripts");
  });

  it("rejects an unknown agent-specific model before a known session-key owner", () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-session-key": "agent:scripts:foobar" }),
        model: "openclaw/missing-agent",
        sessionPrefix: "openai",
      }),
    ).toThrow(/Unknown agent/);
  });

  it("does not build session state for explicit unknown agent ids", () => {
    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-agent-id": "missing-agent" }),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).toThrow(/Unknown agent/);

    expect(() =>
      resolveGatewayRequestContext({
        req: createReq(),
        model: "openclaw/missing-agent",
        sessionPrefix: "openai",
      }),
    ).toThrow(/Unknown agent/);

    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-agent-id": "!!!" }),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).toThrow("Unknown agent '!!!'.");
  });

  it("rejects invalid model syntax before accepting an explicit agent header", () => {
    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-agent-id": "main" }),
        model: "gpt-4o",
        sessionPrefix: "openai",
      }),
    ).toThrow("Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.");
  });

  it("infers the owner from an agent-prefixed session key in an explicit multi-agent fleet", () => {
    runtimeConfig.value = {
      agents: {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "scripts" }],
      },
    };

    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-session-key": "agent:scripts:foobar" }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.agentId).toBe("scripts");
    expect(result.sessionKey).toBe("agent:scripts:foobar");
  });

  it("selects the owner from x-openclaw-agent-id in an explicit multi-agent fleet", () => {
    runtimeConfig.value = {
      agents: {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "scripts" }],
      },
    };

    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-agent-id": "scripts" }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.agentId).toBe("scripts");
    expect(result.sessionKey).toMatch(/^agent:scripts:/);
  });

  it("keeps the session key owner over a default agent for a generic model", () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-session-key": "agent:scripts:foobar" }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.agentId).toBe("scripts");
  });

  it("rejects an agent header that conflicts with the session key owner", () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({
          "x-openclaw-agent-id": "main",
          "x-openclaw-session-key": "agent:scripts:foobar",
        }),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).toThrow("Selected agent 'main' does not match the agent in `x-openclaw-session-key`");
  });

  it("rejects an agent-specific model that conflicts with the session key owner", () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-session-key": "agent:scripts:foobar" }),
        model: "openclaw/main",
        sessionPrefix: "openai",
      }),
    ).toThrow("Selected agent 'main' does not match the agent in `x-openclaw-session-key`");
  });

  it("accepts a selector that agrees with the session key owner", () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    const result = resolveGatewayRequestContext({
      req: createReq({
        "x-openclaw-agent-id": "scripts",
        "x-openclaw-session-key": "agent:scripts:foobar",
      }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.agentId).toBe("scripts");
    expect(result.sessionKey).toBe("agent:scripts:foobar");
  });

  it("still requires an explicit owner when a multi-agent fleet request has no session key or agent header", () => {
    runtimeConfig.value = {
      agents: {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "scripts" }],
      },
    };

    expect(() =>
      resolveGatewayRequestContext({
        req: createReq(),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).toThrow(AgentSelectionRequiredError);
  });
});

describe("resolveTrustedHttpOperatorScopes", () => {
  it("drops self-asserted scopes for bearer-authenticated requests", () => {
    const scopes = resolveTrustedHttpOperatorScopes(
      createReq({
        authorization: "Bearer secret",
        "x-openclaw-scopes": "operator.admin, operator.write",
      }),
      sharedSecretRequestAuth,
    );

    expect(scopes).toStrictEqual([]);
  });

  it("keeps trusted identity scopes even if bearer auth headers are forwarded", () => {
    const scopes = resolveTrustedHttpOperatorScopes(
      createReq({
        authorization: "Bearer upstream-idp-token",
        "x-openclaw-scopes": "operator.admin, operator.write",
      }),
      trustedRequestAuth,
    );

    expect(scopes).toEqual(["operator.admin", "operator.write"]);
  });

  it.each<{
    label: string;
    roleScopes: GatewayOperatorRoleDefinition["scopes"];
    expectedScopes: string[];
    expectedDefaults: string[];
  }>([
    {
      label: "read",
      roleScopes: ["operator.read"],
      expectedScopes: ["operator.read"],
      expectedDefaults: ["operator.read"],
    },
    {
      label: "admin",
      roleScopes: ["operator.admin"],
      expectedScopes: [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.talk",
        "operator.approvals",
        "operator.talk.secrets",
      ],
      expectedDefaults: [...CLI_DEFAULT_OPERATOR_SCOPES],
    },
    {
      label: "write",
      roleScopes: ["operator.write"],
      expectedScopes: ["operator.read", "operator.write", "operator.talk"],
      expectedDefaults: ["operator.read", "operator.write"],
    },
    { label: "empty", roleScopes: [], expectedScopes: [], expectedDefaults: [] },
  ])(
    "caps trusted-proxy headers and defaults to the verified profile's $label role",
    ({ roleScopes, expectedScopes, expectedDefaults }) => {
      const requestAuth = {
        trustDeclaredOperatorScopes: true,
        operatorRolePolicy: {
          sessions: { others: "view" as const },
          agents: ["guest"],
          scopes: roleScopes,
        },
      };

      expect(
        resolveTrustedHttpOperatorScopes(
          createReq({
            "x-openclaw-scopes":
              "operator.admin, operator.read, operator.write, operator.talk, operator.approvals, operator.talk.secrets",
          }),
          requestAuth,
        ),
      ).toEqual(expectedScopes);
      expect(resolveTrustedHttpOperatorScopes(createReq(), requestAuth)).toEqual(expectedDefaults);
      expect(
        resolveTrustedHttpOperatorScopes(
          createReq({ "x-openclaw-scopes": "operator.read" }),
          requestAuth,
        ),
      ).toEqual(roleScopes.length ? ["operator.read"] : []);
      expect(
        resolveTrustedHttpOperatorScopes(
          createReq({ "x-openclaw-scopes": "operator.admin" }),
          requestAuth,
        ),
      ).toEqual(roleScopes);
      expect(
        resolveTrustedHttpOperatorScopes(createReq({ "x-openclaw-scopes": "" }), requestAuth),
      ).toEqual([]);
    },
  );
});

describe("authorizeOpenAiCompatibleHttpModelOverride", () => {
  it("allows shared-secret bearer callers to use x-openclaw-model", () => {
    expect(
      authorizeOpenAiCompatibleHttpModelOverride(
        createReq({ authorization: "Bearer secret", "x-openclaw-model": "openai/gpt-5.4" }),
        { authMethod: "token", trustDeclaredOperatorScopes: false },
      ),
    ).toEqual({ allowed: true });
  });

  it("allows trusted admin callers to use x-openclaw-model", () => {
    expect(
      authorizeOpenAiCompatibleHttpModelOverride(
        createReq({
          "x-openclaw-scopes": "operator.admin, operator.write",
          "x-openclaw-model": "openai/gpt-5.4",
        }),
        { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
      ),
    ).toEqual({ allowed: true });
  });

  it("rejects trusted write-only callers that try to use x-openclaw-model", () => {
    expect(
      authorizeOpenAiCompatibleHttpModelOverride(
        createReq({
          "x-openclaw-scopes": "operator.write",
          "x-openclaw-model": "openai/gpt-5.4",
        }),
        { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
      ),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });
});
