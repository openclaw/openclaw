import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const requestContext = (
  sessionKey: string,
  overrides: Partial<Parameters<typeof resolveGatewayRequestContext>[0]> = {},
) =>
  resolveGatewayRequestContext({
    req: createReq({ "x-openclaw-session-key": sessionKey }),
    model: "openclaw",
    sessionPrefix: "openai",
    ...overrides,
  });

beforeEach(() => sessionEntries.clear());

describe("resolveGatewayRequestContext", () => {
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(clearRuntimeConfigSnapshot);

  it("uses normalized x-openclaw-message-channel", async () => {
    const result = await requestContext("", {
      req: createReq({ "x-openclaw-message-channel": " Custom-Channel " }),
    });
    expect(result.messageChannel).toBe("custom-channel");
  });

  it("includes session prefix and user in generated session key", async () => {
    const result = await requestContext("", {
      req: createReq(),
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

  it.each([
    ["missing-agent", "openclaw", /Unknown agent/],
    [undefined, "openclaw/missing-agent", /Unknown agent/],
    ["!!!", "openclaw", "Unknown agent '!!!'."],
    ["main", "gpt-4o", "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`."],
  ] as const)("rejects agent=%s model=%s before session creation", async (agent, model, error) => {
    await expect(
      requestContext("", {
        req: createReq(agent === undefined ? {} : { "x-openclaw-agent-id": agent }),
        model,
      }),
    ).rejects.toThrow(error);
  });
});

describe("resolveTrustedHttpOperatorScopes", () => {
  it.each([
    [sharedSecretRequestAuth, []],
    [trustedRequestAuth, ["operator.admin", "operator.write"]],
  ] as const)("accepts declared scopes only for trusted identity %j", (auth, expected) => {
    expect(
      resolveTrustedHttpOperatorScopes(
        createReq({
          authorization: "Bearer upstream-idp-token",
          "x-openclaw-scopes": "operator.admin, operator.write",
        }),
        auth,
      ),
    ).toStrictEqual(expected);
  });

  it.each<[string, GatewayOperatorRoleDefinition["scopes"], string[], string[]]>([
    ["read", ["operator.read"], ["operator.read"], ["operator.read"]],
    [
      "admin",
      ["operator.admin"],
      [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.talk",
        "operator.approvals",
        "operator.talk.secrets",
      ],
      [...CLI_DEFAULT_OPERATOR_SCOPES],
    ],
    [
      "write",
      ["operator.write"],
      ["operator.read", "operator.write", "operator.talk"],
      ["operator.read", "operator.write"],
    ],
    ["empty", [], [], []],
  ])(
    "caps trusted-proxy headers and defaults to the verified profile's %s role",
    (_label, roleScopes, expectedScopes, expectedDefaults) => {
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

it.each([
  ["token", undefined, { allowed: true }],
  ["trusted-proxy", "operator.admin, operator.write", { allowed: true }],
  ["trusted-proxy", "operator.write", { allowed: false, missingScope: "operator.admin" }],
] as const)("authorizes model overrides for %s with %j", (authMethod, scopes, expected) => {
  expect(
    authorizeOpenAiCompatibleHttpModelOverride(
      createReq({
        ...(scopes === undefined
          ? { authorization: "Bearer secret" }
          : { "x-openclaw-scopes": scopes }),
        "x-openclaw-model": "openai/gpt-5.4",
      }),
      { authMethod, trustDeclaredOperatorScopes: authMethod === "trusted-proxy" },
    ),
  ).toEqual(expected);
});
