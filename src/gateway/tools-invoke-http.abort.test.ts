import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  prepareSystemAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { authorizeScopedGatewayHttpRequestOrReply } from "./http-utils.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

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

let server: ReturnType<typeof createServer> | undefined;
let serverPort = 0;
let resolveGatewayContext: GatewayContextResolver | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
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

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address() as AddressInfo | null;
      serverPort = address?.port ?? 0;
      resolve();
    });
  });
});

afterAll(async () => {
  const activeServer = server;
  if (!activeServer) {
    return;
  }
  activeServer.closeAllConnections();
  await new Promise<void>((resolve) => {
    activeServer.close(() => resolve());
  });
  server = undefined;
});

beforeEach(() => {
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

function invokeAbortProbe(signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${serverPort}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "abort_probe", args: {} }),
    signal,
  });
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
    let reportAuthorizationStarted: ((req: IncomingMessage) => void) | undefined;
    let releaseAuthorization: (() => void) | undefined;
    const authorizationStarted = new Promise<IncomingMessage>((resolve) => {
      reportAuthorizationStarted = resolve;
    });
    const authorizationReleased = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });

    lifecycle.authorize.mockImplementationOnce(async ({ req }) => {
      reportAuthorizationStarted?.(req);
      await authorizationReleased;
      return {
        cfg: {},
        requestAuth: authorizedRequest(),
        operatorScopes: [],
      };
    });

    const requestController = new AbortController();
    const response = invokeAbortProbe(requestController.signal);

    try {
      const serverRequest = await authorizationStarted;
      requestController.abort();
      await expect(response).rejects.toThrow();
      await expect.poll(() => serverRequest.socket.destroyed).toBe(true);

      releaseAuthorization?.();
      await expect.poll(() => lifecycle.handled.mock.calls.length).toBe(1);
      expect(lifecycle.execute).not.toHaveBeenCalled();
    } finally {
      releaseAuthorization?.();
      requestController.abort();
      await response.catch(() => undefined);
    }
  });

  it("revokes the tool signal after a successful request and releases its disconnect watcher", async () => {
    const revoked = vi.fn();
    lifecycle.execute.mockImplementationOnce(async (_toolCallId, _args, signal) => {
      // Observe while the tool owns the signal: Node 24 composites retain weak
      // sources until subscribed, so a later getter can lose an aborted source to GC.
      signal?.addEventListener("abort", revoked, { once: true });
      return { ok: true };
    });
    const response = await invokeAbortProbe();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, result: { ok: true } });
    expect(lifecycle.execute).toHaveBeenCalledTimes(1);

    const toolSignal = lifecycle.execute.mock.calls[0]?.[2];
    expect(toolSignal).toBeInstanceOf(AbortSignal);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(toolSignal?.aborted).toBe(true);
    expect(lifecycle.beforeHook).toHaveBeenCalledWith(
      expect.objectContaining({ signal: toolSignal }),
    );
  });

  it("retains each child's original grant after HTTP completion without adopting a replacement", async () => {
    await withOpenClawTestState({ label: "http-tool-child-authority" }, async () => {
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
      lifecycle.execute.mockImplementation(async () => {
        const scope = getPluginRuntimeGatewayRequestScope();
        const authority = scope?.client?.internal?.operatorRunAuthority;
        if (!scope?.signal || !scope.hasCurrentClientAuthority || !authority) {
          throw new Error("Tool did not receive the original operator authority");
        }
        expect(scope.context).toBe(context);
        expect(scope.resolveGatewayContext).toBe(resolveGatewayContext);
        expect(scope.hasCurrentClientAuthority()).toBe(true);
        scope.signal.addEventListener("abort", requestEnded, { once: true });
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
              authenticatedUserProfile: {
                profileId: person.id,
                displayName: person.displayName,
                hasAvatar: false,
                updatedAt: person.updatedAt,
              },
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
    let reportStarted: ((signal: AbortSignal | undefined) => void) | undefined;
    let releaseExecution: (() => void) | undefined;
    const executionStarted = new Promise<AbortSignal | undefined>((resolve) => {
      reportStarted = resolve;
    });

    lifecycle.execute.mockImplementation(async (_toolCallId, _args, signal) => {
      reportStarted?.(signal);
      await new Promise<void>((resolve) => {
        releaseExecution = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ok: true };
    });

    const requestController = new AbortController();
    const response = invokeAbortProbe(requestController.signal);

    try {
      const toolSignal = await executionStarted;
      expect(toolSignal).toBeInstanceOf(AbortSignal);

      requestController.abort();
      await expect(response).rejects.toThrow();
      await expect.poll(() => toolSignal?.aborted).toBe(true);
    } finally {
      requestController.abort();
      releaseExecution?.();
      await response.catch(() => undefined);
    }
  });

  it("does not start a tool after the client disconnects during its policy hook", async () => {
    let reportHookStarted: ((signal: AbortSignal | undefined) => void) | undefined;
    let releaseHook: (() => void) | undefined;
    const hookStarted = new Promise<AbortSignal | undefined>((resolve) => {
      reportHookStarted = resolve;
    });
    const hookReleased = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });

    lifecycle.beforeHook.mockImplementationOnce(async ({ params, signal }) => {
      reportHookStarted?.(signal);
      await hookReleased;
      return { blocked: false as const, params };
    });

    const requestController = new AbortController();
    const response = invokeAbortProbe(requestController.signal);

    try {
      const hookSignal = await hookStarted;
      expect(hookSignal).toBeInstanceOf(AbortSignal);

      requestController.abort();
      await expect(response).rejects.toThrow();
      await expect.poll(() => hookSignal?.aborted).toBe(true);

      releaseHook?.();
      await expect.poll(() => lifecycle.handled.mock.calls.length).toBe(1);
      expect(lifecycle.execute).not.toHaveBeenCalled();
    } finally {
      releaseHook?.();
      requestController.abort();
      await response.catch(() => undefined);
    }
  });
});
