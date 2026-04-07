import fs from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import {
  drainSystemEvents,
  peekSystemEventEntries,
  peekSystemEvents,
} from "../infra/system-events.js";
import { DEDUPE_TTL_MS } from "./server-constants.js";
import {
  connectWebchatClient,
  cronIsolatedRun,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  testState,
  withGatewayServer,
  waitForSystemEvent,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const resolveMainKey = () => resolveMainSessionKeyFromConfig();
const HOOK_TOKEN = "hook-secret";

afterEach(() => {
  vi.restoreAllMocks();
});

function buildHookJsonHeaders(options?: {
  token?: string | null;
  headers?: Record<string, string>;
}): Record<string, string> {
  const token = options?.token === undefined ? HOOK_TOKEN : options.token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options?.headers,
  };
}

async function postHook(
  port: number,
  path: string,
  body: Record<string, unknown> | string,
  options?: {
    token?: string | null;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: buildHookJsonHeaders(options),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function setMainAndHooksAgents(): void {
  testState.agentsConfig = {
    list: [{ id: "main", default: true }, { id: "hooks" }],
  };
}

function mockIsolatedRunOkOnce(): void {
  cronIsolatedRun.mockClear();
  cronIsolatedRun.mockResolvedValueOnce({
    status: "ok",
    summary: "done",
  });
}

function mockIsolatedRunOk(): void {
  cronIsolatedRun.mockClear();
  cronIsolatedRun.mockResolvedValue({
    status: "ok",
    summary: "done",
  });
}

async function postAgentHookWithIdempotency(
  port: number,
  idempotencyKey: string,
  headers?: Record<string, string>,
) {
  const response = await postHook(
    port,
    "/hooks/agent",
    { message: "Do it", name: "Email" },
    { headers: { "Idempotency-Key": idempotencyKey, ...headers } },
  );
  expect(response.status).toBe(200);
  return response;
}

async function expectFirstHookDelivery(
  port: number,
  idempotencyKey: string,
  headers?: Record<string, string>,
) {
  const expectedCalls = cronIsolatedRun.mock.calls.length + 1;
  const first = await postAgentHookWithIdempotency(port, idempotencyKey, headers);
  const firstBody = (await first.json()) as { runId?: string };
  expect(firstBody.runId).toBeTruthy();
  await vi.waitFor(() => {
    expect(cronIsolatedRun).toHaveBeenCalledTimes(expectedCalls);
  });
  return firstBody;
}

describe("gateway server hooks", () => {
  test("handles auth, wake, and agent flows", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      const resNoAuth = await postHook(port, "/hooks/wake", { text: "Ping" }, { token: null });
      expect(resNoAuth.status).toBe(401);

      const resWake = await postHook(port, "/hooks/wake", { text: "Ping", mode: "next-heartbeat" });
      expect(resWake.status).toBe(200);
      const wakeEvents = await waitForSystemEvent();
      expect(wakeEvents.some((e) => e.includes("Ping"))).toBe(true);
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgent = await postHook(port, "/hooks/agent", { message: "Do it", name: "Email" });
      expect(resAgent.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });
      const firstCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        deliveryContract?: string;
        job?: { payload?: { externalContentSource?: string } };
      };
      expect(firstCall?.deliveryContract).toBe("shared");
      expect(firstCall?.job?.payload?.externalContentSource).toBe("webhook");
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);

      mockIsolatedRunOkOnce();
      const resAgentModel = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        model: "openai/gpt-4.1-mini",
      });
      expect(resAgentModel.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });
      const call = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { payload?: { model?: string } };
      };
      expect(call?.job?.payload?.model).toBe("openai/gpt-4.1-mini");
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);

      mockIsolatedRunOkOnce();
      const resAgentWithId = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "hooks",
      });
      expect(resAgentWithId.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });
      const routedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(routedCall?.job?.agentId).toBe("hooks");
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);

      mockIsolatedRunOkOnce();
      const resAgentUnknown = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "missing-agent",
      });
      expect(resAgentUnknown.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });
      const fallbackCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(fallbackCall?.job?.agentId).toBe("main");
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);

      const resQuery = await postHook(
        port,
        "/hooks/wake?token=hook-secret",
        { text: "Query auth" },
        { token: null },
      );
      expect(resQuery.status).toBe(400);

      const resBadChannel = await postHook(port, "/hooks/agent", {
        message: "Nope",
        channel: "sms",
      });
      expect(resBadChannel.status).toBe(400);
      expect(peekSystemEvents(resolveMainKey()).length).toBe(0);

      const resHeader = await postHook(
        port,
        "/hooks/wake",
        { text: "Header auth" },
        { token: null, headers: { "x-openclaw-token": HOOK_TOKEN } },
      );
      expect(resHeader.status).toBe(200);
      const headerEvents = await waitForSystemEvent();
      expect(headerEvents.some((e) => e.includes("Header auth"))).toBe(true);
      drainSystemEvents(resolveMainKey());

      const resGet = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "GET",
        headers: { Authorization: "Bearer hook-secret" },
      });
      expect(resGet.status).toBe(405);

      const resBlankText = await postHook(port, "/hooks/wake", { text: " " });
      expect(resBlankText.status).toBe(400);

      const resBlankMessage = await postHook(port, "/hooks/agent", { message: " " });
      expect(resBlankMessage.status).toBe(400);

      const resBadJson = await postHook(port, "/hooks/wake", "{");
      expect(resBadJson.status).toBe(400);
    });
  });

  test("preserves mapped hook provenance across async dispatch", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "gmail" },
          action: "agent",
          messageTemplate: "New email from {{messages[0].from}}",
          sessionKey: "main",
        },
      ],
    };
    setMainAndHooksAgents();

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOkOnce();
      const response = await postHook(port, "/hooks/gmail", {
        source: "gmail",
        messages: [{ id: "msg-1", from: "Ada", subject: "Hello", snippet: "Hi", body: "Body" }],
      });
      expect(response.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });

      const call = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        sessionKey?: string;
        job?: { payload?: { externalContentSource?: string } };
      };
      expect(call?.sessionKey).toBe("main");
      expect(call?.job?.payload?.externalContentSource).toBe("gmail");
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);
    });
  });

  test("does not mirror /hooks/agent run outcomes into main-session system events", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    setMainAndHooksAgents();

    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockReset();
      cronIsolatedRun.mockResolvedValueOnce({
        status: "ok",
        summary: "done",
        delivered: false,
      });

      const okResponse = await postHook(port, "/hooks/agent", {
        message: "Run this task",
        name: "No mirror",
      });
      expect(okResponse.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);

      cronIsolatedRun.mockReset();
      cronIsolatedRun.mockRejectedValueOnce(new Error("run failed"));

      const failedResponse = await postHook(port, "/hooks/agent", {
        message: "Run this task",
        name: "No mirror",
      });
      expect(failedResponse.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);
    });
  });

  test("queues direct and mapped wake payloads as untrusted system events", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "mapped-wake" },
          action: "wake",
          textTemplate: "Mapped wake: {{payload.subject}}",
        },
      ],
    };

    await withGatewayServer(async ({ port }) => {
      const direct = await postHook(port, "/hooks/wake", { text: "Direct wake" });
      expect(direct.status).toBe(200);
      await waitForSystemEvent();
      expect(peekSystemEventEntries(resolveMainKey())).toEqual([
        expect.objectContaining({
          text: "Direct wake",
          trusted: false,
        }),
      ]);
      drainSystemEvents(resolveMainKey());

      const mapped = await postHook(port, "/hooks/mapped-wake", { subject: "Email" });
      expect(mapped.status).toBe(200);
      await waitForSystemEvent();
      expect(peekSystemEventEntries(resolveMainKey())).toEqual([
        expect.objectContaining({
          text: "Mapped wake: Email",
          trusted: false,
        }),
      ]);
      drainSystemEvents(resolveMainKey());
    });
  });

  test("rejects request sessionKey unless hooks.allowRequestSessionKey is enabled", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const denied = await postHook(port, "/hooks/agent", {
        message: "Do it",
        sessionKey: "agent:main:dm:u99999",
      });
      expect(denied.status).toBe(400);
      const deniedBody = (await denied.json()) as { error?: string };
      expect(deniedBody.error).toContain("hooks.allowRequestSessionKey");
    });
  });

  test("respects hooks session policy for request + mapping session keys", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
      defaultSessionKey: "hook:ingress",
      mappings: [
        {
          match: { path: "mapped-ok" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
          sessionKey: "hook:mapped:{{payload.id}}",
        },
        {
          match: { path: "mapped-bad" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
          sessionKey: "agent:main:main",
        },
      ],
    };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });

      const defaultRoute = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ message: "No key" }),
      });
      expect(defaultRoute.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });
      const defaultCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string }
        | undefined;
      expect(defaultCall?.sessionKey).toBe("hook:ingress");
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);

      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });
      const mappedOk = await fetch(`http://127.0.0.1:${port}/hooks/mapped-ok`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ subject: "hello", id: "42" }),
      });
      expect(mappedOk.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });
      const mappedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string }
        | undefined;
      expect(mappedCall?.sessionKey).toBe("hook:mapped:42");
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);

      const requestBadPrefix = await postHook(port, "/hooks/agent", {
        message: "Bad key",
        sessionKey: "agent:main:main",
      });
      expect(requestBadPrefix.status).toBe(400);

      const mappedBadPrefix = await postHook(port, "/hooks/mapped-bad", { subject: "hello" });
      expect(mappedBadPrefix.status).toBe(400);
    });
  });

  test("preserves target-agent prefixes before isolated dispatch", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "agent:"],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOkOnce();

      const resAgent = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "hooks",
        sessionKey: "agent:hooks:slack:channel:c123",
      });
      expect(resAgent.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });

      const routedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string; job?: { agentId?: string } }
        | undefined;
      expect(routedCall?.job?.agentId).toBe("hooks");
      expect(routedCall?.sessionKey).toBe("agent:hooks:slack:channel:c123");
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);
    });
  });

  test("rebinds mismatched agent prefixes to the hook target before isolated dispatch", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "agent:"],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOkOnce();

      const resAgent = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "hooks",
        sessionKey: "agent:main:slack:channel:c123",
      });
      expect(resAgent.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });

      const routedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string; job?: { agentId?: string } }
        | undefined;
      expect(routedCall?.job?.agentId).toBe("hooks");
      expect(routedCall?.sessionKey).toBe("agent:hooks:slack:channel:c123");
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);
    });
  });

  test("rejects rebinding into a session namespace that is not allowlisted", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "agent:main:"],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      const denied = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "hooks",
        sessionKey: "agent:main:slack:channel:c123",
      });
      expect(denied.status).toBe(400);
      const body = (await denied.json()) as { error?: string };
      expect(body.error).toContain("sessionKey must start with one of");
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    });
  });

  test("dedupes repeated /hooks/agent deliveries by idempotency key", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      const firstBody = await expectFirstHookDelivery(port, "hook-idem-1");
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      const second = await postAgentHookWithIdempotency(port, "hook-idem-1");
      const secondBody = (await second.json()) as { runId?: string };
      expect(secondBody.runId).toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);
    });
  });

  test("dedupes hook retries even when trusted-proxy client IP changes", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    expect(configPath).toBeTruthy();
    await fs.writeFile(
      configPath!,
      JSON.stringify({ gateway: { trustedProxies: ["127.0.0.1"] } }, null, 2),
      "utf-8",
    );

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      const firstBody = await expectFirstHookDelivery(port, "hook-idem-forwarded", {
        "X-Forwarded-For": "198.51.100.10",
      });
      const second = await postAgentHookWithIdempotency(port, "hook-idem-forwarded", {
        "X-Forwarded-For": "203.0.113.25",
      });
      const secondBody = (await second.json()) as { runId?: string };
      expect(secondBody.runId).toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
    });
  });

  test("does not retain oversized idempotency keys for replay dedupe", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    const oversizedKey = "x".repeat(257);

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      await expectFirstHookDelivery(port, oversizedKey);
      await postAgentHookWithIdempotency(port, oversizedKey);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
      });

      expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
    });
  });

  test("expires hook idempotency entries from first delivery time", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      const firstBody = await expectFirstHookDelivery(port, "fixed-window-idem");

      nowSpy.mockReturnValue(1_000_000 + DEDUPE_TTL_MS - 1);
      const second = await postHook(
        port,
        "/hooks/agent",
        { message: "Do it", name: "Email" },
        { headers: { "Idempotency-Key": "fixed-window-idem" } },
      );
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { runId?: string };
      expect(secondBody.runId).toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_000_000 + DEDUPE_TTL_MS + 1);
      const third = await postHook(
        port,
        "/hooks/agent",
        { message: "Do it", name: "Email" },
        { headers: { "Idempotency-Key": "fixed-window-idem" } },
      );
      expect(third.status).toBe(200);
      const thirdBody = (await third.json()) as { runId?: string };
      expect(thirdBody.runId).toBeTruthy();
      expect(thirdBody.runId).not.toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
    });
  });

  test("enforces hooks.allowedAgentIds for explicit agent routing", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowedAgentIds: ["hooks"],
      mappings: [
        {
          match: { path: "mapped" },
          action: "agent",
          agentId: "main",
          messageTemplate: "Mapped: {{payload.subject}}",
        },
      ],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOkOnce();
      const resNoAgent = await postHook(port, "/hooks/agent", { message: "No explicit agent" });
      expect(resNoAgent.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });
      const noAgentCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(noAgentCall?.job?.agentId).toBeUndefined();
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);

      mockIsolatedRunOkOnce();
      const resAllowed = await postHook(port, "/hooks/agent", {
        message: "Allowed",
        agentId: "hooks",
      });
      expect(resAllowed.status).toBe(200);
      await vi.waitFor(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });
      const allowedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(allowedCall?.job?.agentId).toBe("hooks");
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);

      const resDenied = await postHook(port, "/hooks/agent", {
        message: "Denied",
        agentId: "main",
      });
      expect(resDenied.status).toBe(400);
      const deniedBody = (await resDenied.json()) as { error?: string };
      expect(deniedBody.error).toContain("hooks.allowedAgentIds");

      const resMappedDenied = await postHook(port, "/hooks/mapped", { subject: "hello" });
      expect(resMappedDenied.status).toBe(400);
      const mappedDeniedBody = (await resMappedDenied.json()) as { error?: string };
      expect(mappedDeniedBody.error).toContain("hooks.allowedAgentIds");
      expect(peekSystemEvents(resolveMainKey()).length).toBe(0);
    });
  });

  test("denies explicit agentId when hooks.allowedAgentIds is empty", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowedAgentIds: [],
    };
    testState.agentsConfig = {
      list: [{ id: "main", default: true }, { id: "hooks" }],
    };
    await withGatewayServer(async ({ port }) => {
      const resDenied = await postHook(port, "/hooks/agent", {
        message: "Denied",
        agentId: "hooks",
      });
      expect(resDenied.status).toBe(400);
      const deniedBody = (await resDenied.json()) as { error?: string };
      expect(deniedBody.error).toContain("hooks.allowedAgentIds");
      expect(peekSystemEvents(resolveMainKey()).length).toBe(0);
    });
  });

  test("throttles repeated hook auth failures and resets after success", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const firstFail = await postHook(
        port,
        "/hooks/wake",
        { text: "blocked" },
        { token: "wrong" },
      );
      expect(firstFail.status).toBe(401);

      let throttled: Response | null = null;
      for (let i = 0; i < 20; i++) {
        throttled = await postHook(port, "/hooks/wake", { text: "blocked" }, { token: "wrong" });
      }
      expect(throttled?.status).toBe(429);
      expect(throttled?.headers.get("retry-after")).toBeTruthy();

      const allowed = await postHook(port, "/hooks/wake", { text: "auth reset" });
      expect(allowed.status).toBe(200);
      await waitForSystemEvent();
      drainSystemEvents(resolveMainKey());

      const failAfterSuccess = await postHook(
        port,
        "/hooks/wake",
        { text: "blocked" },
        { token: "wrong" },
      );
      expect(failAfterSuccess.status).toBe(401);
    });
  });

  test("rejects non-POST hook requests without consuming auth failure budget", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      let lastGet: Response | null = null;
      for (let i = 0; i < 21; i++) {
        lastGet = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
          method: "GET",
          headers: { Authorization: "Bearer wrong" },
        });
      }
      expect(lastGet?.status).toBe(405);
      expect(lastGet?.headers.get("allow")).toBe("POST");

      const allowed = await postHook(port, "/hooks/wake", { text: "still works" });
      expect(allowed.status).toBe(200);
      await waitForSystemEvent();
      drainSystemEvents(resolveMainKey());
    });
  });

  test("enforces /hooks/message auth parity and blocks query token auth", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const noAuth = await postHook(
        port,
        "/hooks/message",
        { message: "inbound", requestId: "msg-auth-missing" },
        { token: null },
      );
      expect(noAuth.status).toBe(401);

      let throttled: Response | null = null;
      for (let i = 0; i < 20; i++) {
        throttled = await postHook(
          port,
          "/hooks/message",
          { message: "inbound", requestId: `msg-auth-wrong-${i}` },
          { token: "wrong" },
        );
      }
      expect(throttled?.status).toBe(429);

      const byBearer = await postHook(port, "/hooks/message", {
        message: "inbound",
        requestId: "msg-auth-bearer",
      });
      const byBearerBody = await byBearer.text();
      expect(byBearer.status, byBearerBody).toBe(200);

      const byHeader = await postHook(
        port,
        "/hooks/message",
        { message: "inbound", requestId: "msg-auth-header" },
        { token: null, headers: { "x-openclaw-token": HOOK_TOKEN } },
      );
      const byHeaderBody = await byHeader.text();
      expect(byHeader.status, byHeaderBody).toBe(200);

      const byQuery = await postHook(
        port,
        "/hooks/message?token=bad",
        { message: "inbound", requestId: "msg-auth-query" },
        { token: null },
      );
      expect(byQuery.status).toBe(400);
    });
  });

  test("applies /hooks/message method guard and dedupes retries by requestId", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    dispatchInboundMessageMock.mockReset();
    dispatchInboundMessageMock.mockImplementation(async () => undefined);

    await withGatewayServer(async ({ port }) => {
      const getResponse = await fetch(`http://127.0.0.1:${port}/hooks/message`, {
        method: "GET",
        headers: { Authorization: `Bearer ${HOOK_TOKEN}` },
      });
      expect(getResponse.status).toBe(405);
      expect(getResponse.headers.get("allow")).toBe("POST");

      const first = await postHook(port, "/hooks/message", {
        message: "dedupe me",
        requestId: "msg-dedupe-1",
      });
      const firstBody = await first.text();
      expect(first.status, firstBody).toBe(200);

      const second = await postHook(port, "/hooks/message", {
        message: "dedupe me",
        requestId: "msg-dedupe-1",
      });
      expect(second.status).toBe(200);

      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  test("routes /hooks/message kind=event without auto-reply dispatch", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    dispatchInboundMessageMock.mockReset();
    dispatchInboundMessageMock.mockImplementation(async () => undefined);

    await withGatewayServer(async ({ port }) => {
      const response = await postHook(port, "/hooks/message", {
        message: "operational event",
        requestId: "msg-event-1",
        kind: "event",
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { status?: string };
      expect(payload.status).toBe("event");
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    });
  });

  test("persists /hooks/message inbound text and emits chat final updates", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    dispatchInboundMessageMock.mockReset();
    dispatchInboundMessageMock.mockImplementation(async () => undefined);

    await withGatewayServer(async ({ port }) => {
      const webchatWs = await connectWebchatClient({ port });
      try {
        const inboundText = "Inbound via webhook";
        const requestId = "msg-ui-1";
        const postResponse = await postHook(port, "/hooks/message", {
          message: inboundText,
          requestId,
          kind: "message",
        });
        const rawPostPayload = await postResponse.text();
        expect(postResponse.status, rawPostPayload).toBe(200);
        const postPayload = JSON.parse(rawPostPayload) as { runId?: string; sessionKey?: string };
        const runId = postPayload.runId ?? requestId;
        const sessionKey = postPayload.sessionKey ?? "main";

        const chatEvent = await onceMessage<{
          type?: string;
          event?: string;
          payload?: Record<string, unknown>;
        }>(
          webchatWs,
          (o) => {
            if (o.type !== "event" || o.event !== "chat") {
              return false;
            }
            const payload = o.payload;
            return payload?.runId === runId && payload?.state === "final";
          },
          10_000,
        );
        expect(chatEvent.event).toBe("chat");
        await vi.waitFor(() => {
          expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
        });
        const firstCall = dispatchInboundMessageMock.mock.calls[0]?.[0] as
          | {
              ctx?: {
                SessionKey?: unknown;
                Body?: unknown;
                RawBody?: unknown;
              };
            }
          | undefined;
        expect(firstCall?.ctx?.SessionKey).toBe(sessionKey);
        expect(firstCall?.ctx?.Body).toBe(inboundText);
        expect(firstCall?.ctx?.RawBody).toBe(inboundText);
      } finally {
        webchatWs.close();
      }
    });
  });
});
