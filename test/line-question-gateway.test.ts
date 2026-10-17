import { createHmac } from "node:crypto";
import { createJiti } from "jiti";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as linePublicApi from "../extensions/line/api.js";
import lineEntry from "../extensions/line/index.js";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "../src/plugin-sdk/channel-ingress-test-runtime.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createStartAccountContext } from "../src/plugin-sdk/test-helpers/start-account-context.js";
import { createDeferred } from "./helpers/promise.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

type GatewayCall = { method: string; params?: Record<string, unknown> };
type HttpRoute = Parameters<
  typeof import("../src/plugins/http-registry.js").registerPluginHttpRoute
>[0];
const boundary = vi.hoisted(() => ({
  paired: [] as string[],
  trace: [] as string[],
  onRoute: undefined as ((route: HttpRoute) => void) | undefined,
  callGateway: vi.fn<(request: GatewayCall) => Promise<unknown>>(),
  upsertPairing: vi.fn(async () => ({ code: "CODE", created: true })),
}));

vi.mock("../src/gateway/call.js", () => ({ callGateway: boundary.callGateway }));
vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => ({
  resolvePairingIdLabel: (await import("../src/pairing/pairing-labels.js")).resolvePairingIdLabel,
  readChannelAllowFromStore: async (
    ...args: Parameters<typeof import("../src/pairing/pairing-store.js").readChannelAllowFromStore>
  ) => {
    expect(args[0]).toBe("line");
    expect(args[2]).toBe("default");
    boundary.trace.push(`store:${boundary.paired.length ? "allowed" : "denied"}`);
    return [...boundary.paired];
  },
  upsertChannelPairingRequest: boundary.upsertPairing,
}));
vi.mock("../src/plugins/http-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugins/http-registry.js")>()),
  registerPluginHttpRoute: (route: HttpRoute) => {
    if (!boundary.onRoute) {
      throw new Error("Unexpected LINE webhook registration");
    }
    boundary.onRoute(route);
    return () => {
      boundary.onRoute = undefined;
    };
  },
}));

// Keep the public plugin in Vitest's graph to intercept Gateway/store IO;
// seed its actual runtime store below rather than using the bootstrap sidecar.
const createEntryLoader: typeof createJiti = (...loaderArgs) =>
  new Proxy(createJiti(...loaderArgs), {
    apply(target, thisArg, args) {
      if (typeof args[0] === "string" && /[/\\]channel-plugin-api\.[cm]?[jt]s$/.test(args[0])) {
        return linePublicApi;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });

const userId = "U0123456789abcdef0123456789abcdef";
const questionId = "ask_0123456789abcdef0123456789abcdef";
const secret = "line-question-test-secret"; // pragma: allowlist secret
const tempDirs = createTempDirTracker();
const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "line",
  errorMessage: "LINE fixture runtime not initialized",
});

beforeEach(() => {
  boundary.paired = [];
  boundary.trace = [];
  boundary.onRoute = undefined;
  boundary.callGateway.mockReset();
  boundary.upsertPairing.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  runtimeStore.clearRuntime();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

type Scenario = {
  name: string;
  paired: boolean;
  policy: "pairing" | "allowlist";
  lookup: "pending" | "terminal" | "failed";
  revoke: "none" | "read" | "reply" | "push";
  push: "success" | "server-error" | "transport-error";
  reply: "success" | "reject" | "partial";
  replyToken: string;
  counts: readonly [writes: number, replies: number, pushes: number, pairings: number];
};
function scenario(
  name: string,
  overrides: Partial<Scenario> = {},
  counts: Scenario["counts"] = [1, 0, 0, 0],
): Scenario {
  return {
    name,
    paired: true,
    policy: "pairing",
    lookup: "pending",
    revoke: "none",
    push: "success",
    reply: "success",
    replyToken: "reply-token",
    counts,
    ...overrides,
  };
}

const terminal = (
  name: string,
  overrides: Partial<Scenario> = {},
  counts: Scenario["counts"] = [0, 1, 0, 0],
) => scenario(name, { lookup: "terminal", ...overrides }, counts);

const scenarios = [
  scenario("allowed pending answer"),
  scenario("initially forbidden", { paired: false, policy: "allowlist" }, [0, 0, 0, 0]),
  scenario("initially unpaired follows pairing policy", { paired: false }, [0, 1, 0, 1]),
  ...(["pending", "terminal", "failed"] as const).map((lookup) =>
    scenario(`revoked during ${lookup} lookup`, { lookup, revoke: "read" }, [0, 0, 0, 0]),
  ),
  terminal("allowed terminal notice"),
  scenario("allowed failed lookup notice", { lookup: "failed" }, [0, 1, 0, 0]),
  terminal("revoked during failed reply prevents push", { revoke: "reply", reply: "reject" }),
  terminal("allowed failed reply falls back to push", { reply: "reject" }, [0, 1, 1, 0]),
  terminal("partial reply never duplicates as push", { reply: "partial" }),
  terminal("revoked tokenless notice", { revoke: "read", replyToken: "" }, [0, 0, 0, 0]),
  ...(["server-error", "transport-error"] as const).flatMap((push) => [
    terminal(`revoked ${push} retry`, { replyToken: "", revoke: "push", push }, [0, 0, 1, 0]),
    terminal(`allowed ${push} retries under the same key`, { replyToken: "", push }, [0, 0, 2, 0]),
  ]),
  terminal("allowed terminal notice without reply token", { replyToken: "" }, [0, 0, 1, 0]),
];

it.each(scenarios)("LINE public webhook question Gateway boundary: $name", async (testCase) => {
  const [writes, replies, pushes, pairings] = testCase.counts;
  const revoke = (stage: Scenario["revoke"]) => {
    if (testCase.revoke === stage) {
      boundary.paired = [];
      boundary.trace.push("pairing:revoked");
    }
  };
  boundary.paired = testCase.paired ? [userId] : [];
  let questionStatus = testCase.lookup === "terminal" ? "answered" : "pending";
  boundary.callGateway.mockImplementation(async ({ method }) => {
    boundary.trace.push(method);
    if (method === "question.get") {
      revoke("read");
      if (testCase.lookup === "failed") {
        throw new Error("Fixture Gateway lookup failed");
      }
      return {
        question: {
          id: questionId,
          status: questionStatus,
          questions: [
            {
              questionId: "deploy_target",
              header: "Target",
              question: "Where should this deploy?",
              options: [{ label: "Staging" }, { label: "Production" }],
            },
          ],
        },
      };
    }
    if (method === "question.resolve") {
      questionStatus = "answered";
      return { status: questionStatus };
    }
    throw new Error(`Unexpected Gateway method: ${method}`);
  });
  const providerCalls: Array<{ operation: string; body: unknown; retryKey: string | null }> = [];
  const unexpectedProviderIo: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const rejectUnexpectedIo = (reason: string): never => {
        unexpectedProviderIo.push(`${method} ${url.origin}${url.pathname}: ${reason}`);
        throw new Error(reason);
      };
      if (url.origin !== "https://api.line.me") {
        return rejectUnexpectedIo("Unexpected provider origin");
      }
      const startupResponses: Record<string, object> = {
        "/v2/bot/info": { userId: "bot", displayName: "Fixture LINE" },
        "/v2/bot/message/quota": { type: "none" },
        "/v2/bot/channel/webhook/endpoint": {
          endpoint: "https://example.test/line/webhook",
          active: true,
        },
      };
      if (method === "GET" && Object.hasOwn(startupResponses, url.pathname)) {
        return Response.json(startupResponses[url.pathname]);
      }
      if (
        method !== "POST" ||
        (url.pathname !== "/v2/bot/message/reply" && url.pathname !== "/v2/bot/message/push")
      ) {
        return rejectUnexpectedIo("Unexpected LINE operation");
      }
      const operation = url.pathname === "/v2/bot/message/reply" ? "reply" : "push";
      if (typeof init?.body !== "string") {
        return rejectUnexpectedIo("Expected JSON string request body");
      }
      let requestBody: unknown;
      try {
        requestBody = JSON.parse(init.body);
      } catch {
        return rejectUnexpectedIo("Invalid JSON request body");
      }
      providerCalls.push({
        operation,
        body: requestBody,
        retryKey: new Headers(init?.headers).get("X-Line-Retry-Key"),
      });
      boundary.trace.push(`line:${operation}`);
      if (
        operation === "push" &&
        testCase.push !== "success" &&
        providerCalls.filter((call) => call.operation === "push").length === 1
      ) {
        revoke("push");
        if (testCase.push === "transport-error") {
          throw Object.assign(new Error("Fixture socket reset"), { code: "ECONNRESET" });
        }
        return Response.json({ message: "Fixture server error" }, { status: 500 });
      }
      if (operation === "reply") {
        revoke("reply");
        if (testCase.reply === "reject") {
          return Response.json({ message: "Invalid reply token" }, { status: 400 });
        }
        if (testCase.reply === "partial") {
          return new Response("not-json", { status: 200 });
        }
      }
      return Response.json({ sentMessages: [{ id: `message-${providerCalls.length}` }] });
    }),
  );

  const stateDir = tempDirs.make("openclaw-line-question-");
  const queue = createChannelIngressQueueForTests({
    channelId: "line",
    accountId: "default",
    stateDir,
  });
  const runtime = createPluginRuntimeMock();
  runtime.state.openChannelIngressQueue = <
    TPayload,
    TMetadata = unknown,
    TCompletedMetadata = unknown,
  >(
    options?: Parameters<PluginRuntime["state"]["openChannelIngressQueue"]>[0],
  ) =>
    createChannelIngressQueueForTests<TPayload, TMetadata, TCompletedMetadata>({
      ...options,
      channelId: "line",
      stateDir,
    });
  const runTurn = vi.fn(async () => {
    throw new Error("Question taps must not start an agent turn");
  });
  runtime.channel.inbound.run = runTurn;
  const plugin = lineEntry.loadChannelPlugin({ createLoaderForTest: createEntryLoader });
  expect(plugin).toBe(linePublicApi.linePlugin);
  runtimeStore.setRuntime(runtime);
  const cfg: OpenClawConfig = {
    channels: {
      line: {
        channelAccessToken: "fixture-token",
        channelSecret: secret,
        dmPolicy: testCase.policy,
        allowFrom: [],
      },
    },
  };
  const account = linePublicApi.linePlugin.config.resolveAccount(cfg, "default");
  const abort = new AbortController();
  if (!plugin.gateway?.startAccount) {
    throw new Error("Expected the public LINE gateway adapter");
  }
  const registered = createDeferred<HttpRoute>();
  boundary.onRoute = registered.resolve;
  const monitor = plugin.gateway.startAccount(
    createStartAccountContext({ account, cfg, abortSignal: abort.signal }),
  );
  try {
    const route = await Promise.race([
      registered.promise,
      monitor.then(() => {
        throw new Error("LINE monitor stopped before webhook registration");
      }),
    ]);
    const body = JSON.stringify({
      destination: "bot",
      events: [
        {
          type: "postback",
          replyToken: testCase.replyToken,
          timestamp: Date.now(),
          source: { type: "user", userId },
          mode: "active",
          webhookEventId: `question-${testCase.name}`,
          deliveryContext: { isRedelivery: false },
          postback: { data: `line.question=${questionId}&line.option=1` },
        },
      ],
    });
    const req = createMockIncomingRequest([body]);
    req.method = "POST";
    req.url = "/line/webhook";
    req.headers = {
      "content-type": "application/json",
      "x-line-signature": createHmac("sha256", secret).update(body).digest("base64"),
    };
    const res = createMockServerResponse();
    await route.handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.getHeader("x-openclaw-delivery-accepted")).toBe("durable");
    await vi.waitFor(
      async () => {
        if (testCase.policy === "pairing") {
          expect(boundary.trace.some((entry) => entry.startsWith("store:"))).toBe(true);
        }
        expect(await queue.listPending()).toHaveLength(0);
        expect(await queue.listClaims()).toHaveLength(0);
      },
      { timeout: 5_000 },
    );
    expect(await queue.listFailed?.()).toEqual([]);
    const calls = boundary.callGateway.mock.calls.map(([request]) => request);
    expect(unexpectedProviderIo).toEqual([]);
    expect(calls.map((request) => request.method)).toEqual(
      testCase.paired ? (writes ? ["question.get", "question.resolve"] : ["question.get"]) : [],
    );
    for (const request of providerCalls) {
      expect(request.body).toMatchObject({
        ...(request.operation === "reply" ? { replyToken: testCase.replyToken } : { to: userId }),
        messages: [{ type: "text", text: expect.any(String) }],
      });
    }
    expect([
      calls.filter((request) => request.method === "question.resolve").length,
      providerCalls.filter((request) => request.operation === "reply").length,
      providerCalls.filter((request) => request.operation === "push").length,
    ]).toEqual([writes, replies, pushes]);
    const pushKeys = providerCalls
      .filter((request) => request.operation === "push")
      .map((request) => request.retryKey);
    if (pushKeys.length) {
      expect(pushKeys[0]).toEqual(expect.any(String));
      expect(new Set(pushKeys).size).toBe(1);
    }
    expect(boundary.upsertPairing).toHaveBeenCalledTimes(pairings);
    expect(runTurn).not.toHaveBeenCalled();
    if (writes) {
      expect(questionStatus).toBe("answered");
      expect(calls.at(-1)?.params).toEqual({
        id: questionId,
        answers: { answers: { deploy_target: ["Production"] } },
        resolvedBy: userId,
      });
    }
    if (writes || testCase.revoke === "read") {
      expect(boundary.trace).toEqual([
        "store:allowed",
        "question.get",
        ...(writes ? ["store:allowed", "question.resolve"] : ["pairing:revoked", "store:denied"]),
      ]);
    } else if (!testCase.paired) {
      expect(calls).toEqual([]);
    }
  } finally {
    abort.abort();
    await monitor;
  }
});
