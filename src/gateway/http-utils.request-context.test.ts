/**
 * Tests HTTP request context extraction for gateway auth and routing.
 */
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import {
  authorizeOpenAiCompatibleHttpModelOverride,
  resolveGatewayRequestContext,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";

const sessionEntries = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("../config/sessions/session-accessor.entry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-accessor.entry.js")>();
  return {
    ...actual,
    readResolvedSessionEntryInWorker: async (params: { sessionKey: string }) =>
      sessionEntries.get(params.sessionKey),
  };
});

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

const sharedSecretRequestAuth = { trustDeclaredOperatorScopes: false };
const trustedRequestAuth = { trustDeclaredOperatorScopes: true };

beforeEach(() => sessionEntries.clear());

describe("resolveGatewayRequestContext", () => {
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
    await expect(
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-session-key": sessionKey }),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).rejects.toThrow(/reserved internal session namespaces/u);
  });

  it("preserves an existing unlocked legacy harness-prefixed override", async () => {
    const sessionKey = "agent:main:harness:legacy-notes";
    sessionEntries.set(sessionKey, { sessionId: "legacy-session", modelSelectionLocked: false });

    const result = await resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-session-key": sessionKey }),
      model: "openclaw",
      sessionPrefix: "openai",
    });

    expect(result.sessionKey).toBe(sessionKey);
  });

  it("rejects an existing locked harness-prefixed override", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    sessionEntries.set(sessionKey, {
      sessionId: "locked-session",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });

    await expect(
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-session-key": sessionKey }),
        model: "openclaw",
        sessionPrefix: "openai",
      }),
    ).rejects.toThrow(/reserved internal session namespaces/u);
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
