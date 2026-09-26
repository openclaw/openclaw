import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";
import { createToolsInvokeHttpTestServer } from "./tools-invoke-http.test-support.js";

const runtime = vi.hoisted(() => {
  const execute = vi.fn(async () => ({ ok: true }));
  return {
    cfg: {} as OpenClawConfig,
    authorize: vi.fn(),
    beforeHook: vi.fn(async ({ params }: { params: Record<string, unknown> }) => ({
      blocked: false as const,
      params,
    })),
    createTools: vi.fn(() =>
      ["session_status", "plugin_doctor"].map((name) => ({
        name,
        parameters: { type: "object", properties: {} },
        execute,
      })),
    ),
    execute,
  };
});

vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => runtime.cfg }));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => runtime.cfg }));
vi.mock("./auth.js", () => ({ authorizeHttpGatewayConnect: runtime.authorize }));
vi.mock("../agents/openclaw-tools.js", () => ({ createOpenClawTools: runtime.createTools }));
vi.mock("../agents/agent-tools.js", () => ({ resolveToolLoopDetectionConfig: () => ({}) }));
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: runtime.beforeHook,
}));

let sharedPort = 0;
const server = createToolsInvokeHttpTestServer({ handleToolsInvoke: handleToolsInvokeHttpRequest });

beforeAll(async () => {
  sharedPort = await server.listen();
});

afterAll(() => server.close());

beforeEach(() => {
  vi.clearAllMocks();
  server.resetContext();
});

const gatewayAuthHeaders = () => ({ "x-openclaw-scopes": "operator.write" });
const postToolsInvoke = async (params: {
  port: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}) =>
  await fetch(`http://127.0.0.1:${params.port}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...params.headers },
    body: JSON.stringify(params.body),
  });

describe.each(["HTTP", "WebSocket"] as const)(
  "standalone role authorization over %s",
  (transport) => {
    const cases: Array<{
      label: string;
      sessionKey?: string;
      toolName?: string;
      sandbox?: "required";
      stored?: boolean;
      system?: boolean;
      expectedError?: string;
    }> = [
      {
        label: "denies a missing session on an agent outside the role",
        sessionKey: "agent:blocked:missing",
        expectedError: 'cannot create sessions for agent "blocked"',
      },
      {
        label: "denies a plugin tool without required session provenance",
        sessionKey: "agent:main:missing",
        toolName: "plugin_doctor",
        sandbox: "required",
        expectedError: "requires a sandboxed session",
      },
      {
        label: "denies a missing main alias without required session provenance",
        sessionKey: "main",
        sandbox: "required",
        expectedError: "requires a sandboxed session",
      },
      {
        label: "denies an omitted target without required session provenance",
        sandbox: "required",
        expectedError: "requires a sandboxed session",
      },
      { label: "allows an authorized missing session", sessionKey: "main" },
      {
        label: "allows an owned required-sandbox session",
        sessionKey: "agent:main:guest-session",
        sandbox: "required",
        stored: true,
      },
      {
        label: "preserves trusted system calls without a session",
        sessionKey: "agent:blocked:missing",
        sandbox: "required",
        system: true,
      },
    ];

    it.each(cases)("$label", async (testCase) => {
      await withOpenClawTestState({ label: "standalone-tool-role" }, async () => {
        const email = "standalone-operator@example.test";
        const profile = ensureProfileForEmail(email);
        runtime.cfg = {
          agents: {
            defaults: { sandbox: { mode: "off" } },
            entries: {
              main: {},
              ...(testCase.sessionKey?.startsWith("agent:blocked:") ? { blocked: {} } : {}),
            },
          },
          session: { mainKey: "primary" },
          gateway: {
            roles: {
              default: "guest",
              definitions: {
                guest: {
                  sessions: { others: "view" },
                  agents: ["main"],
                  scopes: ["operator.write"],
                  sandbox: testCase.sandbox,
                },
              },
            },
          },
        };
        if (testCase.stored) {
          const sessionKey = expectDefined(testCase.sessionKey, "stored fixture session key");
          const entry = {
            sessionId: "standalone-guest-session",
            updatedAt: 1,
            visibility: "shared" as const,
            createdActor: { type: "human" as const, source: "profile" as const, id: profile.id },
            sandbox: "required" as const,
          };
          await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
        }
        const input = {
          name: testCase.toolName ?? "session_status",
          ...(testCase.sessionKey ? { sessionKey: testCase.sessionKey } : {}),
        };
        const expectedOutcome = testCase.expectedError
          ? { ok: false, error: { message: expect.stringContaining(testCase.expectedError) } }
          : { ok: true };
        if (transport === "HTTP") {
          runtime.authorize.mockResolvedValue(
            testCase.system
              ? { ok: true, method: "token" }
              : { ok: true, method: "trusted-proxy", user: email },
          );
          const response = await postToolsInvoke({
            port: sharedPort,
            headers: gatewayAuthHeaders(),
            body: input,
          });
          expect(response.status).toBe(testCase.expectedError ? 403 : 200);
          expect(await response.json()).toMatchObject(expectedOutcome);
        } else {
          const client = createOperatorWsClient({ scopes: ["operator.write"] });
          if (testCase.system) {
            client.internal = { operatorRoleActor: { kind: "system" } };
          } else {
            client.authenticatedUserProfile = {
              profileId: profile.id,
              displayName: profile.displayName,
              avatarRevision: "test-avatar",
              hasAvatar: false,
              updatedAt: profile.updatedAt,
            };
          }
          const { dispatcher, awaitResponseFrame } = createDispatchTestHarness({
            buildRequestContext: () => ({ getRuntimeConfig: () => runtime.cfg }),
          });
          await dispatcher.dispatch(
            { type: "req", id: "standalone-tool", method: "tools.invoke", params: input },
            client,
          );
          expect(await awaitResponseFrame("standalone-tool")).toMatchObject({
            ok: true,
            payload: expectedOutcome,
          });
        }
        if (testCase.expectedError) {
          expect(runtime.beforeHook).not.toHaveBeenCalled();
          expect(runtime.createTools).not.toHaveBeenCalled();
          expect(runtime.execute).not.toHaveBeenCalled();
        } else {
          expect(runtime.beforeHook).toHaveBeenCalledOnce();
          expect(runtime.execute).toHaveBeenCalledOnce();
        }
      });
    });
  },
);
