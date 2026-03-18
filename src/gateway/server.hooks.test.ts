import fs from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { DEDUPE_TTL_MS } from "./server-constants.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
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

async function postHookRaw(
  port: number,
  path: string,
  body: string,
  options?: {
    token?: string | null;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options?.headers,
    },
    body,
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
  const first = await postAgentHookWithIdempotency(port, idempotencyKey, headers);
  const firstBody = (await first.json()) as { runId?: string };
  expect(firstBody.runId).toBeTruthy();
  await waitForSystemEvent();
  drainSystemEvents(resolveMainKey());
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
      const agentEvents = await waitForSystemEvent();
      expect(agentEvents.some((e) => e.includes("Hook Email: done"))).toBe(true);
      const firstCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        deliveryContract?: string;
      };
      expect(firstCall?.deliveryContract).toBe("shared");
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgentModel = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        model: "openai/gpt-4.1-mini",
      });
      expect(resAgentModel.status).toBe(200);
      await waitForSystemEvent();
      const call = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { payload?: { model?: string } };
      };
      expect(call?.job?.payload?.model).toBe("openai/gpt-4.1-mini");
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgentWithId = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "hooks",
      });
      expect(resAgentWithId.status).toBe(200);
      await waitForSystemEvent();
      const routedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(routedCall?.job?.agentId).toBe("hooks");
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgentUnknown = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "missing-agent",
      });
      expect(resAgentUnknown.status).toBe(200);
      await waitForSystemEvent();
      const fallbackCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(fallbackCall?.job?.agentId).toBe("main");
      drainSystemEvents(resolveMainKey());

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

  test("accepts unauthenticated formspree webhook payloads and routes them to ops", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowedAgentIds: ["ops", "main"],
      defaultSessionKey: "hook:visitor-intake",
      allowedSessionKeyPrefixes: ["hook:"],
    };
    testState.agentsConfig = {
      list: [{ id: "main", default: true }, { id: "ops" }],
    };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });

      const jsonRes = await fetch(`http://127.0.0.1:${port}/hooks/formspree`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "person@example.com",
          company: "Deepnoa",
          phone: "03-0000-0000",
          service: "AI Agent導入支援",
          subject: "資料請求",
          message: "資料をお願いします",
        }),
      });
      expect(jsonRes.status).toBe(200);
      const jsonBody = (await jsonRes.json()) as {
        event?: { type?: string; category?: string };
        intakeSession?: {
          routing?: { service?: string };
          contact?: { has_company?: boolean; has_phone?: boolean; has_message?: boolean };
        };
        visibleSessionKey?: string;
      };
      expect(jsonBody.event?.type).toBe("visitor.inquiry.detected");
      expect(jsonBody.event?.category).toBe("document_request");
      expect(jsonBody.intakeSession?.routing?.service).toBe("AI Agent導入支援");
      expect(jsonBody.intakeSession?.contact?.has_company).toBe(true);
      expect(jsonBody.intakeSession?.contact?.has_phone).toBe(true);
      expect(jsonBody.intakeSession?.contact?.has_message).toBe(true);
      expect((jsonBody as { visibleSessionKey?: string }).visibleSessionKey).toMatch(
        /^hook:formspree:[0-9a-f]{12}$/,
      );
      await waitForSystemEvent();
      expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
      const calls = cronIsolatedRun.mock.calls.map(
        (call) =>
          call[0] as {
            sessionKey?: string;
            job?: {
              agentId?: string;
              payload?: { message?: string; channel?: string; deliver?: boolean };
            };
          },
      );
      const visibleCall = calls.find((call) => call.job?.agentId === "main");
      const opsCall = calls.find((call) => call.job?.agentId === "ops");
      expect(visibleCall?.sessionKey).toMatch(/^hook:formspree:[0-9a-f]{12}$/);
      expect(visibleCall?.job?.payload?.channel).toBe("webchat");
      expect(visibleCall?.job?.payload?.deliver).toBe(false);
      expect(visibleCall?.job?.payload?.message).toContain("visitor.inquiry.detected");
      expect(visibleCall?.job?.payload?.message).toContain("has_message=true");
      expect(visibleCall?.job?.payload?.message).not.toContain("company=Deepnoa");
      expect(visibleCall?.job?.payload?.message).not.toContain("person@example.com");
      const jsonCall = opsCall as
        | { job?: { agentId?: string; payload?: { message?: string } } }
        | undefined;
      expect(jsonCall?.job?.agentId).toBe("ops");
      expect(jsonCall?.job?.payload?.message).toContain("visitor.inquiry.detected");
      expect(jsonCall?.job?.payload?.message).toContain("service=AI Agent導入支援");
      expect(jsonCall?.job?.payload?.message).toContain("company=Deepnoa");
      drainSystemEvents(resolveMainKey());

      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });
      const boundary = "----OpenClawFormspreeBoundary";
      const multipartBody = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="email"',
        "",
        "person@example.com",
        `--${boundary}`,
        'Content-Disposition: form-data; name="message"',
        "",
        "営業のご連絡です",
        `--${boundary}--`,
        "",
      ].join("\r\n");
      const multipartRes = await postHookRaw(port, "/hooks/formspree", multipartBody, {
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      });
      expect(multipartRes.status).toBe(200);
      const multipartJson = (await multipartRes.json()) as { event?: { category?: string } };
      expect(multipartJson.event?.category).toBe("sales");
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
      await waitForSystemEvent();
      const defaultCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string }
        | undefined;
      expect(defaultCall?.sessionKey).toBe("hook:ingress");
      drainSystemEvents(resolveMainKey());

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
      await waitForSystemEvent();
      const mappedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string }
        | undefined;
      expect(mappedCall?.sessionKey).toBe("hook:mapped:42");
      drainSystemEvents(resolveMainKey());

      const requestBadPrefix = await postHook(port, "/hooks/agent", {
        message: "Bad key",
        sessionKey: "agent:main:main",
      });
      expect(requestBadPrefix.status).toBe(400);

      const mappedBadPrefix = await postHook(port, "/hooks/mapped-bad", { subject: "hello" });
      expect(mappedBadPrefix.status).toBe(400);
    });
  });

  test("normalizes duplicate target-agent prefixes before isolated dispatch", async () => {
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
      await waitForSystemEvent();

      const routedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string; job?: { agentId?: string } }
        | undefined;
      expect(routedCall?.job?.agentId).toBe("hooks");
      expect(routedCall?.sessionKey).toBe("slack:channel:c123");
      drainSystemEvents(resolveMainKey());
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
      await waitForSystemEvent();

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
      await waitForSystemEvent();
      const noAgentCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(noAgentCall?.job?.agentId).toBeUndefined();
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAllowed = await postHook(port, "/hooks/agent", {
        message: "Allowed",
        agentId: "hooks",
      });
      expect(resAllowed.status).toBe(200);
      await waitForSystemEvent();
      const allowedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(allowedCall?.job?.agentId).toBe("hooks");
      drainSystemEvents(resolveMainKey());

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
});
