import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
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

vi.mock("../config/sessions/session-accessor.entry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-accessor.entry.js")>();
  return {
    ...actual,
    readResolvedSessionEntryInWorker: async (params: { sessionKey: string }) =>
      sessionEntries.get(params.sessionKey),
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
const requestContext = (sessionKey: string) =>
  resolveGatewayRequestContext({
    req: createReq({ "x-openclaw-session-key": sessionKey }),
    model: "openclaw",
    sessionPrefix: "openai",
  });

beforeEach(() => {
  sessionEntries.clear();
  runtimeConfig.value = {};
});

describe("resolveGatewayRequestContext", () => {
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(clearRuntimeConfigSnapshot);

  it("uses normalized x-openclaw-message-channel", async () => {
    const result = await resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-message-channel": " Custom-Channel " }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.messageChannel).toBe("custom-channel");
  });

  it("includes session prefix and user in generated session key", async () => {
    const result = await resolveGatewayRequestContext({
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
  ])("rejects reserved internal session-key override %s", async (sessionKey) => {
    await expect(requestContext(sessionKey)).rejects.toThrow(
      /reserved internal session namespaces/u,
    );
  });

  it("preserves an existing unlocked legacy harness-prefixed override", async () => {
    const sessionKey = "agent:main:harness:legacy-notes";
    sessionEntries.set(sessionKey, { sessionId: "legacy-session", modelSelectionLocked: false });

    expect((await requestContext(sessionKey)).sessionKey).toBe(sessionKey);
  });

  it("rejects an existing locked harness-prefixed override", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    sessionEntries.set(sessionKey, {
      sessionId: "locked-session",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });

    await expect(requestContext(sessionKey)).rejects.toThrow(
      /reserved internal session namespaces/u,
    );
  });

  it("lets a valid agent header win over an unknown agent-specific model", async () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    const result = await resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-agent-id": "scripts" }),
      model: "openclaw/missing-agent",
      sessionPrefix: "openai",
    });

    expect(result.agentId).toBe("scripts");
  });

  it("rejects an unknown agent-specific model before a known session-key owner", async () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    await expect(
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-session-key": "agent:scripts:foobar" }),
        model: "openclaw/missing-agent",
        sessionPrefix: "openai",
      }),
    ).rejects.toThrow(/Unknown agent/);
  });

  it("does not build session state for explicit unknown agent ids", async () => {
    await expect(
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-agent-id": "missing-agent" }),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).rejects.toThrow(/Unknown agent/);

    await expect(
      resolveGatewayRequestContext({
        req: createReq(),
        model: "openclaw/missing-agent",
        sessionPrefix: "openai",
      }),
    ).rejects.toThrow(/Unknown agent/);

    await expect(
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-agent-id": "!!!" }),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).rejects.toThrow("Unknown agent '!!!'.");
  });

  it("rejects invalid model syntax before accepting an explicit agent header", async () => {
    await expect(
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-agent-id": "main" }),
        model: "gpt-4o",
        sessionPrefix: "openai",
      }),
    ).rejects.toThrow("Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.");
  });

  it("infers the owner from an agent-prefixed session key in an explicit multi-agent fleet", async () => {
    runtimeConfig.value = {
      agents: {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "scripts" }],
      },
    };

    const result = await resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-session-key": "agent:scripts:foobar" }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.agentId).toBe("scripts");
    expect(result.sessionKey).toBe("agent:scripts:foobar");
  });

  it("selects the owner from x-openclaw-agent-id in an explicit multi-agent fleet", async () => {
    runtimeConfig.value = {
      agents: {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "scripts" }],
      },
    };

    const result = await resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-agent-id": "scripts" }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.agentId).toBe("scripts");
    expect(result.sessionKey).toMatch(/^agent:scripts:/);
  });

  it("keeps the session key owner over a default agent for a generic model", async () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    const result = await resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-session-key": "agent:scripts:foobar" }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.agentId).toBe("scripts");
  });

  it("rejects an agent header that conflicts with the session key owner", async () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    await expect(
      resolveGatewayRequestContext({
        req: createReq({
          "x-openclaw-agent-id": "main",
          "x-openclaw-session-key": "agent:scripts:foobar",
        }),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).rejects.toThrow("Selected agent 'main' does not match the agent in `x-openclaw-session-key`");
  });

  it("rejects an agent-specific model that conflicts with the session key owner", async () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    await expect(
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-session-key": "agent:scripts:foobar" }),
        model: "openclaw/main",
        sessionPrefix: "openai",
      }),
    ).rejects.toThrow("Selected agent 'main' does not match the agent in `x-openclaw-session-key`");
  });

  it("accepts a selector that agrees with the session key owner", async () => {
    runtimeConfig.value = {
      agents: {
        list: [{ id: "main", default: true }, { id: "scripts" }],
      },
    };

    const result = await resolveGatewayRequestContext({
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

  it("still requires an explicit owner when a multi-agent fleet request has no session key or agent header", async () => {
    runtimeConfig.value = {
      agents: {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "scripts" }],
      },
    };

    await expect(
      resolveGatewayRequestContext({
        req: createReq(),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).rejects.toThrow(AgentSelectionRequiredError);
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
      const scopes = (value?: string) =>
        resolveTrustedHttpOperatorScopes(
          createReq(value === undefined ? {} : { "x-openclaw-scopes": value }),
          requestAuth,
        );

      expect(
        scopes(
          "operator.admin, operator.read, operator.write, operator.talk, operator.approvals, operator.talk.secrets",
        ),
      ).toEqual(expectedScopes);
      expect(scopes()).toEqual(expectedDefaults);
      expect(scopes("operator.read")).toEqual(roleScopes.length ? ["operator.read"] : []);
      expect(scopes("operator.admin")).toEqual(roleScopes);
      expect(scopes("")).toEqual([]);
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
