// Public LINE entry proof keeps webhook admission and both question resolvers real.
import { createHmac } from "node:crypto";
import { createJiti } from "jiti";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The existing entry test loader keeps the public plugin module in Vitest's graph,
// so Gateway transport and store IO are intercepted. Seed the actual public runtime
// store below; the unchanged broad bootstrap sidecar loader is outside this fixture.
// No private plugin imports or production exports are added for this test.
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
  writes: number;
  replies: number;
  pushes: number;
  pairings: number;
};
function scenario(name: string, overrides: Partial<Scenario> = {}): Scenario {
  return {
    name,
    paired: true,
    policy: "pairing",
    lookup: "pending",
    revoke: "none",
    push: "success",
    reply: "success",
    replyToken: "reply-token",
    writes: 1,
    replies: 0,
    pushes: 0,
    pairings: 0,
    ...overrides,
  };
}

const scenarios = [
  scenario("allowed pending answer"),
  scenario("initially forbidden", { paired: false, policy: "allowlist", writes: 0 }),
  scenario("initially unpaired follows pairing policy", {
    paired: false,
    writes: 0,
    replies: 1,
    pairings: 1,
  }),
  scenario("revoked during pending lookup", { revoke: "read", writes: 0 }),
  scenario("revoked during terminal lookup", { lookup: "terminal", revoke: "read", writes: 0 }),
  scenario("revoked during failed lookup", { lookup: "failed", revoke: "read", writes: 0 }),
  scenario("allowed terminal notice", { lookup: "terminal", writes: 0, replies: 1 }),
  scenario("allowed failed lookup notice", { lookup: "failed", writes: 0, replies: 1 }),
  scenario("revoked during failed reply prevents push", {
    lookup: "terminal",
    revoke: "reply",
    reply: "reject",
    writes: 0,
    replies: 1,
  }),
  scenario("allowed failed reply falls back to push", {
    lookup: "terminal",
    reply: "reject",
    writes: 0,
    replies: 1,
    pushes: 1,
  }),
  scenario("partial reply never duplicates as push", {
    lookup: "terminal",
    reply: "partial",
    writes: 0,
    replies: 1,
  }),
  scenario("revoked terminal notice without reply token", {
    lookup: "terminal",
    revoke: "read",
    replyToken: "",
    writes: 0,
  }),
  ...(["server-error", "transport-error"] as const).flatMap((push) => [
    scenario(`revoked after ${push} prevents push retry`, {
      lookup: "terminal",
      replyToken: "",
      revoke: "push",
      push,
      writes: 0,
      pushes: 1,
    }),
    scenario(`allowed ${push} retries under the same key`, {
      lookup: "terminal",
      replyToken: "",
      push,
      writes: 0,
      pushes: 2,
    }),
  ]),
  scenario("allowed terminal notice without reply token", {
    lookup: "terminal",
    replyToken: "",
    writes: 0,
    pushes: 1,
  }),
];

describe("LINE public webhook question Gateway boundary", () => {
  it.each(scenarios)("$name", async (testCase) => {
    boundary.paired = testCase.paired ? [userId] : [];
    let questionStatus = testCase.lookup === "terminal" ? "answered" : "pending";
    boundary.callGateway.mockImplementation(async ({ method }) => {
      boundary.trace.push(method);
      if (method === "question.get") {
        if (testCase.revoke === "read") {
          boundary.paired = [];
          boundary.trace.push("pairing:revoked");
        }
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
        if (method === "GET" && url.pathname === "/v2/bot/info") {
          return Response.json({ userId: "bot", displayName: "Fixture LINE" });
        }
        if (method === "GET" && url.pathname === "/v2/bot/message/quota") {
          return Response.json({ type: "none" });
        }
        if (method === "GET" && url.pathname === "/v2/bot/channel/webhook/endpoint") {
          return Response.json({ endpoint: "https://example.test/line/webhook", active: true });
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
          if (testCase.revoke === "push") {
            boundary.paired = [];
            boundary.trace.push("pairing:revoked");
          }
          if (testCase.push === "transport-error") {
            throw Object.assign(new Error("Fixture socket reset"), { code: "ECONNRESET" });
          }
          return Response.json({ message: "Fixture server error" }, { status: 500 });
        }
        if (operation === "reply" && testCase.revoke === "reply") {
          boundary.paired = [];
          boundary.trace.push("pairing:revoked");
        }
        if (operation === "reply" && testCase.reply === "reject") {
          return Response.json({ message: "Invalid reply token" }, { status: 400 });
        }
        if (operation === "reply" && testCase.reply === "partial") {
          return new Response("not-json", { status: 200 });
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
    const runtimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("Unexpected runtime exit");
      },
    };
    if (!plugin.gateway?.startAccount) {
      throw new Error("Expected the public LINE gateway adapter");
    }
    const registered = createDeferred<HttpRoute>();
    boundary.onRoute = registered.resolve;
    const monitor = plugin.gateway.startAccount(
      createStartAccountContext({ account, cfg, runtime: runtimeEnv, abortSignal: abort.signal }),
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
      console.info(
        "LINE_QUESTION_GATEWAY_PROOF",
        JSON.stringify({
          scenario: testCase.name,
          trace: boundary.trace,
          writes: calls.filter((request) => request.method === "question.resolve").length,
          replies: providerCalls.filter((request) => request.operation === "reply").length,
          pushes: providerCalls.filter((request) => request.operation === "push").length,
          pairings: boundary.upsertPairing.mock.calls.length,
        }),
      );
      expect(unexpectedProviderIo).toEqual([]);
      expect(calls.map((request) => request.method)).toEqual(
        testCase.paired
          ? testCase.writes
            ? ["question.get", "question.resolve"]
            : ["question.get"]
          : [],
      );
      for (const request of providerCalls) {
        expect(request.body).toMatchObject({
          ...(request.operation === "reply" ? { replyToken: testCase.replyToken } : { to: userId }),
          messages: [{ type: "text", text: expect.any(String) }],
        });
      }
      expect(calls.filter((request) => request.method === "question.resolve")).toHaveLength(
        testCase.writes,
      );
      expect(providerCalls.filter((request) => request.operation === "reply")).toHaveLength(
        testCase.replies,
      );
      expect(providerCalls.filter((request) => request.operation === "push")).toHaveLength(
        testCase.pushes,
      );
      const pushKeys = providerCalls
        .filter((request) => request.operation === "push")
        .map((request) => request.retryKey);
      if (pushKeys.length) {
        expect(pushKeys[0]).toEqual(expect.any(String));
        expect(new Set(pushKeys).size).toBe(1);
      }
      expect(boundary.upsertPairing).toHaveBeenCalledTimes(testCase.pairings);
      expect(runTurn).not.toHaveBeenCalled();
      if (testCase.writes) {
        expect(questionStatus).toBe("answered");
        expect(calls.at(-1)?.params).toEqual({
          id: questionId,
          answers: { answers: { deploy_target: ["Production"] } },
          resolvedBy: userId,
        });
        expect(boundary.trace).toEqual([
          "store:allowed",
          "question.get",
          "store:allowed",
          "question.resolve",
        ]);
      } else if (testCase.revoke === "read") {
        expect(boundary.trace).toEqual([
          "store:allowed",
          "question.get",
          "pairing:revoked",
          "store:denied",
        ]);
      } else if (!testCase.paired) {
        expect(calls).toEqual([]);
      }
    } finally {
      abort.abort();
      await monitor;
    }
  });
});
