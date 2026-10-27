import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";
import {
  createToolsInvokeHttpTestServer,
  withToolsInvokeTestState,
} from "./tools-invoke-http.test-support.js";
import { invokeGatewayTool } from "./tools-invoke-shared.js";

type FixtureTool = Pick<AnyAgentTool, "name" | "parameters"> &
  Partial<Pick<AnyAgentTool, "label" | "description">> & {
    execute: (...args: Parameters<AnyAgentTool["execute"]>) => Promise<unknown>;
  };
const runtime = vi.hoisted(() => {
  const execute = vi.fn(async () => ({ ok: true }));
  return {
    cfg: {} as OpenClawConfig,
    authorize: vi.fn(),
    beforeHook: vi.fn(async ({ params }: { params: Record<string, unknown> }) => ({
      blocked: false as const,
      params,
    })),
    createTools: vi.fn<() => Promise<FixtureTool[]>>(async () =>
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
// mock-isolation: Keep execution inert while exercising HTTP and WebSocket authorization.
vi.mock("../agents/openclaw-tools.js", () => ({ createOpenClawToolsAsync: runtime.createTools }));
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
afterEach(() => memorySessionActorOwners.reset());

beforeEach(() => {
  vi.clearAllMocks();
  server.resetContext();
  runtime.cfg = { agents: { entries: { main: {} } } };
  runtime.authorize.mockResolvedValue({ ok: true, method: "token" });
});

const postToolsInvoke = async (body: Record<string, unknown>, scopes = "operator.write") =>
  await fetch(`http://127.0.0.1:${sharedPort}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openclaw-scopes": scopes },
    body: JSON.stringify(body),
  });

it("refuses tool execution when its memory session closes during the before-tool hook", async () => {
  await withToolsInvokeTestState({ label: "memory-tool-closure" }, async () => {
    const sessionKey = "agent:main:dashboard:incognito-tool-closure";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "private-tool", updatedAt: 1, incognito: true },
    );
    runtime.beforeHook.mockImplementationOnce(async ({ params }) => {
      memorySessionActorOwners.reset();
      return { blocked: false, params };
    });
    const response = await postToolsInvoke({ name: "session_status", sessionKey });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { message: "tool execution failed" },
    });
    expect(runtime.beforeHook).toHaveBeenCalledOnce();
    expect(runtime.execute).not.toHaveBeenCalled();
  });
});

describe.each(["HTTP", "WebSocket"] as const)(
  "standalone role authorization over %s",
  (transport) => {
    type RoleCase = {
      sessionKey?: string;
      toolName?: string;
      sandbox?: "required";
      stored?: boolean;
      incognito?: boolean;
      admin?: boolean;
      system?: boolean;
      revokeMember?: boolean;
      expectedError?: string;
    };
    const sandboxCase = (sessionKey?: string, options: RoleCase = {}): RoleCase => ({
      sessionKey,
      sandbox: "required",
      ...options,
    });
    const missingSandbox = (sessionKey?: string, toolName?: string) =>
      sandboxCase(sessionKey, { toolName, expectedError: "requires a sandboxed session" });
    const memoryKey = "agent:main:dashboard:incognito-tools";
    const memoryCase = sandboxCase(memoryKey, { stored: true, incognito: true });
    const cases: Record<string, RoleCase> = {
      "denies out-of-role session creation": {
        sessionKey: "agent:blocked:missing",
        expectedError: 'cannot create sessions for agent "blocked"',
      },
      "plugin provenance": missingSandbox("agent:main:missing", "plugin_doctor"),
      "main-alias provenance": missingSandbox("main"),
      "omitted-target provenance": missingSandbox(),
      "authorized missing session": { sessionKey: "main" },
      "owned sandbox session": sandboxCase("agent:main:guest-session", { stored: true }),
      "non-admin memory-session owner": {
        ...memoryCase,
        expectedError: `Incognito session "${memoryKey}" was not found.`,
      },
      "memory-session admin": { ...memoryCase, admin: true },
      "sessionless system call": sandboxCase("agent:blocked:missing", { system: true }),
      "denies membership revoked during the hook": {
        sessionKey: "agent:main:member-session",
        stored: true,
        revokeMember: true,
        expectedError: "session is read-only",
      },
    };

    it.each(Object.entries(cases))("%s", async (_label, testCase) => {
      const stateOptions = { label: "standalone-tool-role", prepareProfileCatalog: true };
      await withToolsInvokeTestState(stateOptions, async () => {
        const email = "standalone-operator@example.test";
        const profile = ensureProfileForEmail(email);
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const role = (admin: boolean): GatewayOperatorRoleDefinition => ({
          sessions: { others: admin ? "write" : "view" },
          agents: admin ? "*" : ["main"],
          scopes: [admin ? "operator.admin" : "operator.write"],
          sandbox: testCase.sandbox,
        });
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
              definitions: { guest: role(false), admin: role(true) },
            },
          },
        };
        if (testCase.admin) {
          setUserProfileRole(profile.id, "admin");
        }
        if (testCase.stored) {
          const sessionKey = expectDefined(testCase.sessionKey, "stored fixture session key");
          const id = testCase.revokeMember ? "another-creator" : profile.id;
          const entry: InternalSessionEntry = {
            sessionId: "standalone-guest-session",
            updatedAt: 1,
            visibility: testCase.revokeMember ? "read-only" : "shared",
            createdActor: { type: "human", source: "profile", id },
            sandbox: "required",
            ...(testCase.incognito ? { incognito: true } : {}),
          };
          await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
          if (testCase.revokeMember) {
            const scope = { agentId: "main", sessionKey };
            await addSessionMember(scope, { identityId: profile.id, addedBy: "another-creator" });
            runtime.beforeHook.mockImplementationOnce(async ({ params }) => {
              await removeSessionMember(scope, profile.id);
              return { blocked: false, params };
            });
          }
        }
        const input = {
          name: testCase.toolName ?? "session_status",
          ...(testCase.sessionKey ? { sessionKey: testCase.sessionKey } : {}),
        };
        const expectedOutcome = testCase.expectedError
          ? { ok: false, error: { message: expect.stringContaining(testCase.expectedError) } }
          : { ok: true };
        const scopes = testCase.admin ? ["operator.admin"] : ["operator.write"];
        if (transport === "HTTP") {
          runtime.authorize.mockResolvedValue(
            testCase.system
              ? { ok: true, method: "token" }
              : { ok: true, method: "trusted-proxy", user: email },
          );
          const response = await postToolsInvoke(input, scopes.join(","));
          expect(response.status).toBe(testCase.expectedError ? 403 : 200);
          expect(await response.json()).toMatchObject(expectedOutcome);
        } else {
          const client = createOperatorWsClient({ scopes });
          client.connect.device = {
            id: "standalone-reviewer",
            publicKey: "test",
            signature: "test",
            signedAt: 1,
            nonce: "test",
          };
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
          const response = await awaitResponseFrame("standalone-tool");
          if (testCase.incognito && testCase.expectedError) {
            expect(response).toMatchObject({
              ok: false,
              payload: undefined,
              error: { code: "INVALID_REQUEST", message: testCase.expectedError },
            });
          } else {
            expect(response).toMatchObject({ ok: true, payload: expectedOutcome });
          }
        }
        const deniedBeforeHook = Boolean(testCase.expectedError && !testCase.revokeMember);
        expect(runtime.beforeHook).toHaveBeenCalledTimes(deniedBeforeHook ? 0 : 1);
        expect(runtime.execute).toHaveBeenCalledTimes(testCase.expectedError ? 0 : 1);
        if (!testCase.expectedError && transport === "WebSocket") {
          expect(runtime.beforeHook).toHaveBeenCalledWith(
            expect.objectContaining({
              ctx: expect.objectContaining({ approvalReviewerDeviceId: "standalone-reviewer" }),
            }),
          );
        }
      });
    });
  },
);

it.each([false, true])(
  "keeps the settled send result boundary (revoked=%s)",
  async (revokeCaller) => {
    const expectedStatus = revokeCaller ? 500 : 200;
    await withToolsInvokeTestState({ label: "standalone-tool-creation" }, async () => {
      const sessionKey = "agent:main:outbound-first-contact";
      let callerCurrent = true;
      runtime.createTools.mockResolvedValueOnce([
        {
          name: "message",
          label: "Message",
          description: "Message result fixture",
          parameters: Type.Object({ action: Type.String() }),
          execute: async () => {
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey },
              {
                sessionId: "outbound-created-session",
                updatedAt: 1,
              },
            );
            callerCurrent = !revokeCaller;
            return {
              content: [{ type: "text", text: "private tool result" }],
              details: {
                messageDelivery: {
                  status: "settled",
                  partialDelivery: false,
                  createdThreadIds: [],
                },
              },
            };
          },
        } satisfies AnyAgentTool,
      ]);
      const input = { name: "message", sessionKey, args: { action: "send" } };
      if (revokeCaller) {
        const outcome = await invokeGatewayTool({
          cfg: runtime.cfg,
          input,
          senderIsOwner: true,
          toolCallIdPrefix: "http",
          assertInvocationCurrent: () => {
            if (!callerCurrent) {
              throw new Error("caller credentials revoked");
            }
          },
        });
        expect(outcome).toMatchObject({ ok: false, status: expectedStatus });
        expect(JSON.stringify(outcome)).not.toContain("private tool result");
        return;
      }
      const response = await postToolsInvoke(input);
      expect(response.status).toBe(expectedStatus);
      const body = await response.text();
      expect(body.includes("private tool result")).toBe(expectedStatus === 200);
    });
  },
);
