import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveHookMappings } from "../hooks-mapping.js";
import { createHooksConfig } from "../hooks-test-helpers.js";
import type { HookAgentDispatchPayload, HooksConfigResolved } from "../hooks.js";
import type { HookAgentCompletion, HookAgentDispatchResult } from "../hooks.types.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "../server-constants.js";
import { createHookRequest, createResponse } from "../server-http.test-harness.js";
import { createHooksRequestHandler } from "./hooks-request-handler.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));

function completedDispatch(runId: string): HookAgentDispatchResult {
  return {
    ok: true,
    runId,
    completion: Promise.resolve({ status: "ok", replyDisposition: "empty" }),
  };
}

vi.mock("../hooks.js", async () => ({
  ...(await vi.importActual<typeof import("../hooks.js")>("../hooks.js")),
  readJsonBody: readJsonBodyMock,
}));

function createGmailHooksConfig(mapping?: {
  config: Parameters<typeof resolveHookMappings>[0];
  configDir: string;
}): HooksConfigResolved {
  if (mapping) {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(mapping.configDir, "openclaw.json"));
  }
  const canonical = createHooksConfig();
  const policy = { allowRequestSessionKey: true, allowedSessionKeyPrefixes: ["hook:gmail:"] };
  return {
    ...canonical,
    mappings: resolveHookMappings({ ...policy, ...(mapping?.config ?? { presets: ["gmail"] }) }),
    sessionPolicy: { ...canonical.sessionPolicy, ...policy },
  };
}

type HandlerOptions = Parameters<typeof createHooksRequestHandler>[0];
function createFanOutHandler(
  params?: Partial<
    Pick<
      HandlerOptions,
      "dispatchWakeHook" | "dispatchAgentHook" | "getHooksConfig" | "fanoutResponseDeadlineMs"
    >
  > & { hooksConfig?: HooksConfigResolved },
) {
  const dispatchWakeHook = vi.fn(
    params?.dispatchWakeHook ?? (() => ({ eventOutcome: "queued" as const })),
  );
  const dispatchAgentHook = vi.fn(
    params?.dispatchAgentHook ??
      ((value: HookAgentDispatchPayload) => completedDispatch(`run:${value.sessionKey}`)),
  );
  const logHooks = { ...createSubsystemLogger("hook-fanout-test"), warn: vi.fn(), info: vi.fn() };
  const hooksConfig = params?.hooksConfig ?? createGmailHooksConfig();
  const handler = createHooksRequestHandler({
    scheduler: createTestGatewayScheduler("fake-timers"),
    getHooksConfig: params?.getHooksConfig ?? (() => hooksConfig),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks,
    dispatchWakeHook,
    dispatchAgentHook,
    fanoutResponseDeadlineMs: params?.fanoutResponseDeadlineMs,
  });
  const startDirect = (idempotencyKey: string, waitForCompletion = false) =>
    startRequest(handler, { message: "direct", idempotencyKey, waitForCompletion });
  return { handler, startDirect, dispatchAgentHook, dispatchWakeHook, logHooks };
}

function startRequest(
  handler: ReturnType<typeof createHooksRequestHandler>,
  payload: Record<string, unknown>,
  url = "/hooks/agent",
) {
  readJsonBodyMock.mockResolvedValueOnce({ ok: true, value: payload });
  const response = createResponse();
  return { response, handling: handler(createHookRequest({ url }), response.res) };
}
async function postGmailPayload(
  handler: ReturnType<typeof createHooksRequestHandler>,
  payload: Record<string, unknown>,
  expectedStatus = 200,
): Promise<unknown> {
  const { response, handling } = startRequest(handler, payload, "/hooks/gmail");
  await handling;
  expect(response.res.statusCode).toBe(expectedStatus);
  return response.getBody() ? JSON.parse(response.getBody()) : undefined;
}

async function expectRun(
  request: ReturnType<typeof startRequest>,
  runId: string,
  completion?: HookAgentCompletion,
) {
  await request.handling;
  expect(JSON.parse(request.response.getBody())).toEqual({
    ok: true,
    runId,
    ...(completion ? { completion } : {}),
  });
}

function gmailMessage(id: string) {
  return { id, from: `${id}@example.com`, subject: `Subject ${id}`, snippet: "s", body: "b" };
}

describe("hook fan-out dispatch", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    readJsonBodyMock.mockReset();
  });

  test("empty batches record a no-op instead of dispatching a junk run", async () => {
    const { handler, dispatchAgentHook } = createFanOutHandler();

    await postGmailPayload(handler, { messages: [] }, 204);
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });

  test("partial failure returns non-2xx and a retry replays instead of duplicating", async () => {
    let failM2 = true;
    const { handler, dispatchAgentHook } = createFanOutHandler({
      dispatchAgentHook: (value) => {
        if (failM2 && value.sessionKey === "hook:gmail:m2") {
          return { ok: false as const, statusCode: 502 as const, error: "admission failed" };
        }
        return completedDispatch(`run:${value.sessionKey}`);
      },
    });
    const payload = { messages: ["m1", "m2", "m3"].map(gmailMessage) };

    expect(await postGmailPayload(handler, payload, 502)).toMatchObject({
      ok: false,
      runIds: ["run:hook:gmail:m1", "run:hook:gmail:m3"],
    });
    expect(dispatchAgentHook).toHaveBeenCalledTimes(3);

    failM2 = false;
    expect(await postGmailPayload(handler, payload)).toHaveProperty("runIds.length", 3);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(4);
    expect(dispatchAgentHook.mock.calls[3]?.[0]?.sessionKey).toBe("hook:gmail:m2");
  });

  test("answers before the producer client timeout when an item admission hangs", async () => {
    const hang = createDeferred<HookAgentDispatchResult>();
    const { handler, dispatchAgentHook } = createFanOutHandler({
      fanoutResponseDeadlineMs: 50,
      dispatchAgentHook: (value) =>
        value.sessionKey === "hook:gmail:slow"
          ? hang.promise
          : completedDispatch(`run:${value.sessionKey}`),
    });
    const payload = { messages: [gmailMessage("fast"), gmailMessage("slow")] };

    expect(await postGmailPayload(handler, payload, 503)).toMatchObject({
      error: expect.stringContaining("pending"),
      runIds: ["run:hook:gmail:fast"],
    });

    hang.resolve(completedDispatch("run:hook:gmail:slow"));
    await postGmailPayload(handler, payload);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);
  });

  test("dispatches identical items separately and replays each on redelivery", async () => {
    let runSeq = 0;
    const { handler, dispatchAgentHook } = createFanOutHandler({
      dispatchAgentHook: () => completedDispatch(`run-${runSeq++}`),
    });
    const payload = { messages: [gmailMessage("twin"), gmailMessage("twin")] };

    expect(await postGmailPayload(handler, payload)).toMatchObject({ runIds: ["run-0", "run-1"] });
    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);

    expect(await postGmailPayload(handler, payload)).toMatchObject({ runIds: ["run-0", "run-1"] });
    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);
  });

  test("bounds fan-out and records the dropped tail", async () => {
    const { handler, dispatchAgentHook, logHooks } = createFanOutHandler();
    const messages = Array.from({ length: 205 }, (_, index) => gmailMessage(`m${index}`));

    await postGmailPayload(handler, { messages });

    expect(dispatchAgentHook).toHaveBeenCalledTimes(200);
    expect(logHooks.warn).toHaveBeenCalledWith(expect.stringContaining("dropped 5 items"));
  });

  test("mixed per-item transform kinds dispatch both wakes and agents", async () => {
    const transformsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-fanout-transform-"));
    try {
      fs.mkdirSync(path.join(transformsDir, "hooks", "transforms"), { recursive: true });
      fs.writeFileSync(
        path.join(transformsDir, "hooks", "transforms", "mixed.mjs"),
        [
          'export default (ctx) => ctx.payload.messages[0].kind === "wake"',
          ' ? { kind: "wake", text: `wake:${ctx.payload.messages[0].id}` }',
          ' : ctx.payload.messages[0].kind === "invalid-agent"',
          '   ? { channel: "missing-channel" }',
          "   : {};",
        ].join(""),
      );
      const hooksConfig = createGmailHooksConfig({
        configDir: transformsDir,
        config: {
          mappings: [
            {
              id: "mixed",
              match: { path: "gmail" },
              action: "agent",
              forEach: "messages",
              sessionKey: "hook:gmail:{{messages[0].id}}",
              messageTemplate: "agent:{{messages[0].id}}",
              transform: { module: "mixed.mjs" },
            },
          ],
        },
      });
      let coalesceWakes = false;
      const { handler, dispatchAgentHook, dispatchWakeHook } = createFanOutHandler({
        hooksConfig,
        dispatchWakeHook: (value) => ({
          eventOutcome: coalesceWakes || value.text === "wake:w1" ? "coalesced" : "queued",
        }),
      });

      const payload = {
        messages: [
          { id: "w1", kind: "wake" },
          { id: "w2", kind: "wake" },
          { id: "a1", kind: "agent" },
        ],
      };
      expect(await postGmailPayload(handler, payload)).toMatchObject({ eventOutcome: "queued" });
      expect(dispatchWakeHook).toHaveBeenCalledTimes(2);
      expect(dispatchWakeHook.mock.calls[0]?.[0]).toMatchObject({ text: "wake:w1" });
      expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
      expect(dispatchAgentHook.mock.calls[0]?.[0]).toMatchObject({
        message: "agent:a1",
        sessionKey: "hook:gmail:a1",
      });

      coalesceWakes = true;
      expect(await postGmailPayload(handler, payload)).toMatchObject({ eventOutcome: "coalesced" });
      expect(dispatchWakeHook).toHaveBeenCalledTimes(4);
      expect(dispatchAgentHook).toHaveBeenCalledTimes(1);

      coalesceWakes = false;
      const invalid = await postGmailPayload(
        handler,
        {
          messages: [
            { id: "w3", kind: "wake" },
            { id: "a2", kind: "invalid-agent" },
          ],
        },
        400,
      );
      expect(invalid).toMatchObject({ ok: false, eventOutcome: "queued" });
      expect(dispatchWakeHook).toHaveBeenCalledTimes(5);
      expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(transformsDir, { recursive: true, force: true });
    }
  });

  test("derives the gmail body bound from the provisioned producer contract", async () => {
    const { resolveHooksConfig } =
      await vi.importActual<typeof import("../hooks.js")>("../hooks.js");
    const baseHooks = {
      enabled: true,
      token: "hook-secret",
      presets: ["gmail"],
      defaultSessionKey: "hook:gmail:ingress",
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:gmail:"],
    };
    const bodyLimits = [undefined, 50_000, 1_048_576].map((maxBytes) =>
      resolveHooksConfig({
        hooks: { ...baseHooks, ...(maxBytes === undefined ? {} : { gmail: { maxBytes } }) },
      } as never)?.maxBodyBytesByPath.get("gmail"),
    );
    expect(bodyLimits).toEqual([6_819_200, 100 * (50_000 * 3 + 8_192), 32 * 1024 * 1024]);
  });

  test("keeps direct completion observation outside dispatch identity", async () => {
    const admission = createDeferred<HookAgentDispatchResult>();
    const completion = createDeferred<HookAgentCompletion>();
    const terminal = { status: "ok", replyDisposition: "silent", delivered: true } as const;
    const { startDirect, dispatchAgentHook } = createFanOutHandler({
      hooksConfig: createHooksConfig(),
      dispatchAgentHook: () => admission.promise,
    });
    const admittedOnly = startDirect("shared-request");
    const waiting = startDirect("shared-request", true);
    await vi.waitFor(() => expect(dispatchAgentHook).toHaveBeenCalledTimes(1));

    admission.resolve({ ok: true, runId: "run:shared", completion: completion.promise });
    await expectRun(admittedOnly, "run:shared");
    expect(waiting.response.getBody()).toBe("");

    completion.resolve(terminal);
    await expectRun(waiting, "run:shared", terminal);
    await expectRun(startDirect("shared-request", true), "run:shared", terminal);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
  });

  test("keeps an active admitted replay owner under terminal cache pressure", async () => {
    const completion = createDeferred<HookAgentCompletion>();
    const terminal = { status: "ok", replyDisposition: "silent" } as const;
    let activeDispatches = 0;
    const { startDirect, dispatchAgentHook } = createFanOutHandler({
      hooksConfig: createHooksConfig(),
      dispatchAgentHook: (value) => {
        if (value.idempotencyKey === "active-owner") {
          activeDispatches += 1;
          return { ok: true, runId: "run:active", completion: completion.promise };
        }
        return completedDispatch(`run:${value.idempotencyKey}`);
      },
    });

    await startDirect("active-owner").handling;

    for (let index = 0; index < DEDUPE_MAX; index += 1) {
      await startDirect(`pressure-${index}`).handling;
    }
    await Promise.resolve();

    const replay = startDirect("active-owner", true);
    await Promise.resolve();
    expect(replay.response.getBody()).toBe("");
    expect(activeDispatches).toBe(1);
    completion.resolve(terminal);
    await expectRun(replay, "run:active", terminal);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(DEDUPE_MAX + 1);
  });

  test("starts replay TTL when active completion settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00.000Z"));
    try {
      const completion = createDeferred<HookAgentCompletion>();
      let dispatches = 0;
      const { startDirect } = createFanOutHandler({
        hooksConfig: createHooksConfig(),
        dispatchAgentHook: () => {
          dispatches += 1;
          return dispatches === 1
            ? { ok: true, runId: "run:active", completion: completion.promise }
            : completedDispatch("run:duplicate");
        },
      });
      const replay = () => startDirect("delayed-admission");

      await replay().handling;

      await vi.advanceTimersByTimeAsync(DEDUPE_TTL_MS + 1);
      await expectRun(replay(), "run:active");
      expect(dispatches).toBe(1);

      completion.resolve({ status: "ok", replyDisposition: "empty" });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(DEDUPE_TTL_MS);
      await expectRun(replay(), "run:active");
      expect(dispatches).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await expectRun(replay(), "run:duplicate");
      expect(dispatches).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects non-boolean direct completion observation", async () => {
    const { handler, dispatchAgentHook } = createFanOutHandler({
      hooksConfig: createHooksConfig(),
    });
    const { response, handling } = startRequest(handler, {
      message: "direct",
      waitForCompletion: "yes",
    });
    await handling;

    expect(response.res.statusCode).toBe(400);
    expect(JSON.parse(response.getBody())).toEqual({
      ok: false,
      error: "waitForCompletion must be boolean",
    });
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });

  test("rejects a direct wake when hook config changes during body parsing", async () => {
    const initial = createHooksConfig();
    let current = initial;
    const body = createDeferred<{ ok: true; value: Record<string, unknown> }>();
    const { handler, dispatchWakeHook } = createFanOutHandler({
      hooksConfig: initial,
      getHooksConfig: () => current,
    });
    readJsonBodyMock.mockReturnValueOnce(body.promise);
    const response = createResponse();
    const handling = handler(createHookRequest(), response.res);

    await vi.waitFor(() => expect(readJsonBodyMock).toHaveBeenCalledTimes(1));
    current = { ...initial };
    body.resolve({ ok: true, value: { text: "stale wake" } });
    await handling;

    expect(response.res.statusCode).toBe(409);
    expect(JSON.parse(response.getBody())).toEqual({
      ok: false,
      error: "hook configuration changed; retry request",
    });
    expect(dispatchWakeHook).not.toHaveBeenCalled();
  });

  test.each([
    ["before direct wake dispatch", "/hooks/wake", { text: "stale wake" }, 3, 0],
    ["inside direct agent dispatch", "/hooks/agent", { message: "stale agent" }, 3, 0],
    ["during mapping", "/hooks/gmail", { messages: [gmailMessage("stale-mapping")] }, 3, 0],
    [
      "before every fan-out item",
      "/hooks/gmail",
      { messages: ["m1", "m2", "m3"].map(gmailMessage) },
      5,
      1,
    ],
  ] as const)("rechecks hook config %s", async (_name, url, value, reads, calls) => {
    const initial = url === "/hooks/gmail" ? createGmailHooksConfig() : createHooksConfig();
    const replacement = { ...initial };
    let configReads = 0;
    const { handler, dispatchAgentHook, dispatchWakeHook } = createFanOutHandler({
      hooksConfig: initial,
      getHooksConfig: () => (++configReads < reads ? initial : replacement),
    });
    const { response, handling } = startRequest(handler, value, url);
    await handling;
    expect(response.res.statusCode).toBe(409);
    if (url === "/hooks/wake") {
      expect(dispatchWakeHook).not.toHaveBeenCalled();
    } else {
      expect(dispatchAgentHook).toHaveBeenCalledTimes(calls);
      if (calls) {
        expect(dispatchAgentHook.mock.calls[0]?.[0].sessionKey).toBe("hook:gmail:m1");
      }
    }
  });
});
