import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  prepareSystemAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { authorizeScopedGatewayHttpRequestOrReply } from "./http-utils.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";

const lifecycle = vi.hoisted(() => ({
  authorize:
    vi.fn<
      (params: {
        req: IncomingMessage;
        res: ServerResponse;
      }) => ReturnType<typeof authorizeScopedGatewayHttpRequestOrReply>
    >(),
  beforeHook: vi.fn(async (args: { params: unknown; signal?: AbortSignal }) => ({
    blocked: false as const,
    params: args.params,
  })),
  handled: vi.fn(),
  execute: vi.fn(async (_toolCallId: string, _args: unknown, _signal?: AbortSignal) => ({
    ok: true,
  })),
}));

vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeScopedGatewayHttpRequestOrReply: lifecycle.authorize,
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: () => ({
    agentId: "main",
    tools: [
      {
        name: "abort_probe",
        parameters: { type: "object", properties: {} },
        execute: lifecycle.execute,
      },
    ],
  }),
}));

vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: lifecycle.beforeHook,
}));

const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");

type RequestAuth = NonNullable<
  Awaited<ReturnType<typeof authorizeScopedGatewayHttpRequestOrReply>>
>["requestAuth"];

function authorizedRequest(overrides: Partial<RequestAuth> = {}): RequestAuth {
  return {
    trustDeclaredOperatorScopes: false,
    hasCurrentClientAuthority: () => true,
    assertCurrent: () => {},
    revalidate: async () => {},
    ...overrides,
  };
}

let origin: string;
let resolveGatewayContext: GatewayContextResolver | undefined;
const server = createServer((req, res) => {
  void handleToolsInvokeHttpRequest(req, res, {
    auth: { mode: "none", allowTailscale: false },
    resolveGatewayContext,
  })
    .then(() => {
      lifecycle.handled();
    })
    .catch((error: unknown) => {
      if (!res.destroyed && !res.writableEnded) {
        res.statusCode = 500;
        res.end(String(error));
      }
    });
});
beforeAll(async () => {
  origin = await listenLoopback(server);
});
afterAll(() => closeHttpServer(server));

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  resolveGatewayContext = undefined;
  lifecycle.authorize.mockReset();
  lifecycle.authorize.mockResolvedValue({
    cfg: {},
    requestAuth: authorizedRequest(),
    operatorScopes: [],
  });
  lifecycle.beforeHook.mockClear();
  lifecycle.handled.mockReset();
  lifecycle.execute.mockReset();
  lifecycle.execute.mockResolvedValue({ ok: true });
});

afterEach(() => clearRuntimeConfigSnapshot());

function invokeAbortProbe(signal?: AbortSignal): Promise<Response> {
  return fetch(`${origin}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "abort_probe", args: {} }),
    signal,
  });
}

async function disconnectDuring<T>(
  started: Promise<T>,
  release: () => void,
  checkDisconnected: (value: T) => Promise<void>,
) {
  const controller = new AbortController();
  const response = invokeAbortProbe(controller.signal);
  try {
    const value = await started;
    controller.abort();
    await expect(response).rejects.toThrow();
    await checkDisconnected(value);
  } finally {
    release();
    controller.abort();
    await response.catch(() => undefined);
  }
}

describe("POST /tools/invoke request cancellation", () => {
  it("rejects a tool when policy authority changes during its awaited hook", async () => {
    const hookStarted = createDeferred();
    const releaseHook = createDeferred();
    let current = true;
    lifecycle.authorize.mockResolvedValueOnce({
      cfg: {},
      requestAuth: authorizedRequest({ hasCurrentClientAuthority: () => current }),
      operatorScopes: [],
    });
    lifecycle.beforeHook.mockImplementationOnce(async ({ params }) => {
      hookStarted.resolve();
      await releaseHook.promise;
      return { blocked: false, params };
    });
    const pending = invokeAbortProbe();
    try {
      await hookStarted.promise;
      current = false;
      releaseHook.resolve();
      const response = await pending;
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Gateway requester authority changed" },
      });
      expect(lifecycle.execute).not.toHaveBeenCalled();
    } finally {
      releaseHook.resolve();
      await pending;
    }
  });

  it("never attaches a disconnect watcher to an unauthorized request", async () => {
    lifecycle.authorize.mockImplementationOnce(async ({ res }) => {
      res.statusCode = 401;
      res.end("unauthorized");
      return null;
    });

    const response = await invokeAbortProbe();

    expect(response.status).toBe(401);
    expect(lifecycle.execute).not.toHaveBeenCalled();
  });

  it("does not start a tool after the client disconnects during authorization", async () => {
    const started = createDeferred<IncomingMessage>();
    const released = createDeferred();
    lifecycle.authorize.mockImplementationOnce(async ({ req }) => {
      started.resolve(req);
      await released.promise;
      return {
        cfg: {},
        requestAuth: authorizedRequest(),
        operatorScopes: [],
      };
    });

    await disconnectDuring(started.promise, released.resolve, async (serverRequest) => {
      await expect.poll(() => serverRequest.socket.destroyed).toBe(true);
      released.resolve();
      await expect.poll(() => lifecycle.handled.mock.calls.length).toBe(1);
      expect(lifecycle.execute).not.toHaveBeenCalled();
    });
  });

  it("retains each child's original grant after HTTP completion without adopting a replacement", async () => {
    const stateOptions = { label: "http-tool-child-authority", prepareProfileCatalog: true };
    await withOpenClawTestState(stateOptions, async () => {
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "writer",
            definitions: {
              writer: {
                sessions: { others: "write" },
                agents: ["main"],
                scopes: ["operator.write"],
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const person = ensureProfileForEmail("http-tool-operator@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const context = createGatewayRequestContext(makeContextParams());
      resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      const originalGrant = new AbortController();
      const replacementGrant = new AbortController();
      const requestEnded = vi.fn();
      const admissions: ReturnType<typeof prepareSystemAgentRunAdmission>[] = [];
      const captures: {
        scope: NonNullable<ReturnType<typeof getPluginRuntimeGatewayRequestScope>>;
        admitted: AdmittedRunContext;
      }[] = [];
      lifecycle.execute.mockImplementation(async (_toolCallId, _args, signal) => {
        const scope = getPluginRuntimeGatewayRequestScope();
        const authority = scope?.client?.internal?.operatorRunAuthority;
        if (!scope?.signal || !scope.hasCurrentClientAuthority || !authority) {
          throw new Error("Tool did not receive the original operator authority");
        }
        expect(scope.context).toBe(context);
        expect(scope.resolveGatewayContext).toBe(resolveGatewayContext);
        expect(scope.hasCurrentClientAuthority()).toBe(true);
        expect(signal).toBe(scope.signal);
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(lifecycle.beforeHook).toHaveBeenCalledWith(expect.objectContaining({ signal }));
        // Subscribe while the tool owns the composite signal, before weak sources can be GC'd.
        signal?.addEventListener("abort", requestEnded, { once: true });
        const admission = prepareSystemAgentRunAdmission(
          cfg,
          `http-tool-child-${admissions.length}`,
          "main",
          "http-tool-child-test",
          undefined,
          authority,
        );
        admissions.push(admission);
        captures.push({ scope, admitted: await admission.admit("embedded") });
        return { ok: true };
      });

      try {
        for (const grant of [originalGrant, replacementGrant]) {
          lifecycle.authorize.mockResolvedValueOnce({
            cfg,
            operatorScopes: ["operator.write"],
            requestAuth: authorizedRequest({
              authMethod: "trusted-proxy",
              trustDeclaredOperatorScopes: true,
              authenticatedUserProfile: gatewayProfile(
                person.id,
                person.displayName,
                person.updatedAt,
              ),
              operatorAccessAuthority: {
                signal: grant.signal,
                assertCurrent: () => grant.signal.throwIfAborted(),
              },
            }),
          });
          const response = await invokeAbortProbe();
          expect(response.status).toBe(200);
          await expect(response.json()).resolves.toEqual({ ok: true, result: { ok: true } });
          const capture = captures.at(-1);
          if (!capture) {
            throw new Error("Tool did not admit its child");
          }
          expect(capture.scope.signal?.aborted).toBe(true);
          expect(capture.scope.hasCurrentClientAuthority?.()).toBe(false);
          const authority = readAdmittedRunOperatorAuthority(capture.admitted);
          expect(authority).toBe(capture.scope.client?.internal?.operatorRunAuthority);
          expect(authority?.profileId).toBe(person.id);
          expect(authority?.scopes).toEqual(["operator.write"]);
          expect(authority?.signal?.aborted).toBe(false);
          expect(() => authority?.assertCurrent()).not.toThrow();
        }

        expect(requestEnded).toHaveBeenCalledTimes(2);
        const [original, replacement] = captures;
        if (!original || !replacement) {
          throw new Error("Expected children admitted by both HTTP requests");
        }
        const originalAuthority = readAdmittedRunOperatorAuthority(original.admitted);
        const replacementAuthority = readAdmittedRunOperatorAuthority(replacement.admitted);
        expect(originalAuthority?.source).not.toBe(replacementAuthority?.source);
        originalGrant.abort(new Error("Original guest grant ended"));
        expect(originalAuthority?.signal?.aborted).toBe(true);
        expect(() => originalAuthority?.assertCurrent()).toThrow("Original guest grant ended");
        expect(() => readAdmittedRunOperatorAuthority(original.admitted)).toThrow(
          "no longer active",
        );
        expect(replacementAuthority?.signal?.aborted).toBe(false);
        expect(() => replacementAuthority?.assertCurrent()).not.toThrow();
        expect(readAdmittedRunOperatorAuthority(replacement.admitted)).toBe(replacementAuthority);
      } finally {
        for (const admission of admissions) {
          admission.close();
        }
        originalGrant.abort();
        replacementGrant.abort();
        resolveGatewayContext = undefined;
      }
    });
  });

  it("aborts the running tool when its HTTP client disconnects", async () => {
    const started = createDeferred<AbortSignal | undefined>();
    const released = createDeferred();
    lifecycle.execute.mockImplementation(async (_toolCallId, _args, signal) => {
      started.resolve(signal);
      signal?.addEventListener("abort", () => released.resolve(), { once: true });
      await released.promise;
      return { ok: true };
    });
    await disconnectDuring(started.promise, released.resolve, async (toolSignal) => {
      expect(toolSignal).toBeInstanceOf(AbortSignal);
      await expect.poll(() => toolSignal?.aborted).toBe(true);
    });
  });

  it("does not start a tool after the client disconnects during its policy hook", async () => {
    const started = createDeferred<AbortSignal | undefined>();
    const released = createDeferred();
    lifecycle.beforeHook.mockImplementationOnce(async ({ params, signal }) => {
      started.resolve(signal);
      await released.promise;
      return { blocked: false as const, params };
    });
    await disconnectDuring(started.promise, released.resolve, async (hookSignal) => {
      expect(hookSignal).toBeInstanceOf(AbortSignal);
      await expect.poll(() => hookSignal?.aborted).toBe(true);
      released.resolve();
      await expect.poll(() => lifecycle.handled.mock.calls.length).toBe(1);
      expect(lifecycle.execute).not.toHaveBeenCalled();
    });
  });
});
