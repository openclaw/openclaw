// Opt-in real-provider proof. All barriers, principals, state and sockets are fixture-owned.
import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import type { OperatorScope } from "./operator-scopes.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

const describeLive =
  isLiveTestEnabled() && process.env.OPENAI_API_KEY?.trim() ? describe : describe.skip;
const MODEL = "openai/gpt-5.4";
const ADMIN: OperatorScope[] = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];
const WRITER: OperatorScope[] = ["operator.read", "operator.write"];
type History = {
  messages: Record<string, unknown>[];
  pendingInputs?: {
    items: Array<{ id: string; runId?: string; message: unknown; state: string; queued?: true }>;
  };
  inputReceipts?: Array<{ runId: string; state: string; queued?: true; cancelled?: true }>;
  inFlightRun?: { runId: string };
};
type HeldRequest = {
  entered: ReturnType<typeof createDeferred<Record<string, unknown>>>;
  release: ReturnType<typeof createDeferred<void>>;
};

// TLS verification remains enabled upstream. The relay delays, but never rewrites, model traffic.
async function providerRelay(signal: AbortSignal) {
  const claim = await acquireTestPortBlock({ offsets: [0] });
  const holds: HeldRequest[] = [];
  const allHolds: HeldRequest[] = [];
  const preparationHolds: HeldRequest[] = [];
  const requests: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const pending = new Set<Promise<void>>();
  const server = createHttpServer((req, res) => {
    const work = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const parsed: Record<string, unknown> = JSON.parse(body.toString("utf8"));
      requests.push(parsed);
      // No-tool preparation completions can precede the receiving agent's request.
      // Hold only its foreground tool-capable request, not the preparation phase.
      const hold = Array.isArray(parsed.tools) ? holds.shift() : preparationHolds.shift();
      if (hold) {
        hold.entered.resolve(parsed);
        await withinTest(hold.release.promise, signal);
      }
      const abort = new AbortController();
      const cancel = () => abort.abort();
      res.on("close", cancel);
      try {
        if (res.destroyed) {
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (
            value !== undefined &&
            !/^(host|connection|content-length|transfer-encoding)$/i.test(name)
          ) {
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
        }
        const upstream = await fetch("https://api.openai.com" + req.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.any([signal, abort.signal]),
        });
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        });
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            res.write(chunk);
          }
        }
        res.end();
      } finally {
        res.off("close", cancel);
      }
    })().catch((error: unknown) => {
      if (!res.destroyed && !signal.aborted) {
        failures.push(error instanceof Error ? error.name : "relay error");
        res.writeHead(502).end("fixture relay failed");
      }
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(claim.port, "127.0.0.1", resolve);
  });
  return {
    url: "http://127.0.0.1:" + claim.port + "/v1",
    requests,
    failures,
    armPreparation() {
      const hold = {
        entered: createDeferred<Record<string, unknown>>(),
        release: createDeferred(),
      };
      preparationHolds.push(hold);
      allHolds.push(hold);
      return hold;
    },
    arm() {
      const hold = {
        entered: createDeferred<Record<string, unknown>>(),
        release: createDeferred(),
      };
      holds.push(hold);
      allHolds.push(hold);
      return hold;
    },
    releaseAll() {
      for (const hold of allHolds) {
        hold.release.resolve();
      }
    },
    async close() {
      for (const hold of allHolds) {
        hold.release.resolve();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all(pending);
      await claim.release();
    },
  };
}

describeLive("quiet steering with real caller authority", () => {
  it("exercises authenticated steering, FIFO, policy changes, cancellation and cold-process recovery", async ({
    signal,
  }) => {
    const relay = await providerRelay(signal);
    const profile = "quiet-proof-" + randomUUID().slice(0, 8);
    const instance = await createOpenClawTestInstance({
      name: profile,
      signal,
      startTimeoutMs: 180_000,
      stopTimeoutMs: 10_000,
      entrypoint: ["dist/index.js", "--profile", profile],
      env: {
        ...Object.fromEntries(
          listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
        ),
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_PROFILE: profile,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_AGENT_RUNTIME: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
      },
    });
    instance.env.OPENCLAW_GATEWAY_PORT = String(instance.port);
    const clients: GatewayClient[] = [];
    const events: Array<{ event?: string; payload?: unknown }> = [];
    const terminals = new Map<string, ReturnType<typeof createDeferred<{ state: string }>>>();
    const terminalFor = (runId: string) => {
      let terminal = terminals.get(runId);
      if (!terminal) {
        terminal = createDeferred<{ state: string }>();
        terminals.set(runId, terminal);
      }
      return terminal;
    };
    const frontClaim = await acquireTestPortBlock({ offsets: [0] });
    const sockets = new Set<net.Socket>();
    // A normal TLS-terminating trusted edge, not an insecure-client exception.
    const front = createTlsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM }, (socket) => {
      const upstream = net.connect(instance.port, "127.0.0.1");
      for (const stream of [socket, upstream]) {
        sockets.add(stream);
        stream.on("close", () => sockets.delete(stream));
        stream.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
      }
      socket.pipe(upstream).pipe(socket);
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    });
    const emails = [
      "high@quiet.example.test",
      "low@quiet.example.test",
      "third@quiet.example.test",
    ];
    const config: OpenClawConfig = {
      gateway: {
        mode: "local",
        port: instance.port,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowUsers: emails,
            allowLoopback: true,
            deviceAutoApprove: { enabled: true, scopes: ADMIN },
          },
        },
        trustedProxies: ["127.0.0.1"],
        controlUi: { enabled: false, allowedOrigins: ["https://control.quiet.example.test"] },
        roles: {
          default: "high",
          definitions: {
            high: { sessions: { others: "write" }, agents: "*", scopes: ADMIN },
            low: { sessions: { others: "write" }, agents: "*", scopes: WRITER },
            blocked: { sessions: { others: "none" }, agents: [], scopes: WRITER },
          },
        },
      },
      logging: { file: instance.state.path("gateway.log") },
      agents: {
        defaults: {
          workspace: instance.state.workspaceDir,
          skipBootstrap: true,
          utilityModel: "",
          timeoutSeconds: 120,
          thinkingDefault: "low",
          model: { primary: MODEL },
          modelPolicy: { allow: [MODEL] },
          models: {
            [MODEL]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
          sandbox: { mode: "off" },
        },
        entries: { main: { workspace: instance.state.workspaceDir } },
      },
      plugins: { enabled: false, slots: { memory: "none" } },
      tools: {
        allow: ["read", "sessions_history"],
        codeMode: { enabled: false },
        toolSearch: false,
      },
      messages: { queue: { allowCollaborativeSteering: false } },
      secrets: { providers: { default: { source: "env" } } },
      models: {
        mode: "merge",
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: relay.url,
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            request: { allowPrivateNetwork: true },
            // Loopback is classified as a compatible endpoint, but this unchanged-body
            // relay reaches OpenAI. Declare its actual schema support so optional
            // arguments stay optional through an explicit strict:false payload.
            models: [
              buildCatalogModel("gpt-5.4", {
                reasoning: true,
                compat: { supportsStrictMode: true },
              }),
            ],
          },
        },
      },
    };
    const ledger: Array<{ name: string; outcome: string; facts?: unknown }> = [];
    const selectedCases = process.env.OPENCLAW_QUIET_STEERING_CASES
      ? new RegExp(process.env.OPENCLAW_QUIET_STEERING_CASES)
      : undefined;
    const safeAssistantText = (message: unknown) => {
      const text = extractAssistantPhaseText(message) ?? "";
      const credential = process.env.OPENAI_API_KEY;
      return (credential ? text.replaceAll(credential, "[redacted]") : text).slice(0, 700);
    };
    const failures: string[] = [];
    const connect = async (index: number) => {
      const email = emails[index];
      if (!email) {
        throw new Error("Missing synthetic principal");
      }
      const client = await connectGatewayClient({
        url: "wss://127.0.0.1:" + frontClaim.port,
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        origin: "https://control.quiet.example.test",
        scopes: ADMIN,
        edgeAuthHeaders: {
          "x-forwarded-user": email,
          "x-forwarded-proto": "https",
          "x-forwarded-for": "203.0.113." + (50 + index),
        },
        deviceIdentity: loadOrCreateDeviceIdentity({
          path: instance.state.statePath(
            "test-identities",
            String(index),
            "client",
            "credentials.sqlite",
          ),
        }),
        caps: ["tool-events"],
        requestTimeoutMs: 140_000,
        signal,
        onEvent: (event) => {
          if (index === 0) {
            events.push(event);
            const payload = event.payload as { runId?: string; state?: string } | undefined;
            if (
              event.event === "chat" &&
              payload?.runId &&
              payload.state &&
              ["final", "error", "aborted"].includes(payload.state)
            ) {
              terminalFor(payload.runId).resolve({ state: payload.state });
            }
          }
        },
      });
      clients.push(client);
      return client;
    };
    let high: GatewayClient;
    let low: GatewayClient;
    let third: GatewayClient;
    const history = async (key: string, runIds?: string[]) => {
      const observed = await high.request<History>("chat.history", {
        sessionKey: key,
        limit: 100,
        maxBytes: 500_000,
        toolResultMaxChars: 50_000,
        ...(runIds?.length ? { inputRunIds: runIds } : {}),
      });
      console.error(
        "[quiet-live-history] " +
          JSON.stringify({
            key,
            receipts: observed.inputReceipts,
            pending: observed.pendingInputs?.items.map(({ runId, state, queued }) => ({
              runId,
              state,
              queued,
            })),
            inFlight: observed.inFlightRun,
            messages: observed.messages.map((message) => ({
              role: message.role,
              type: message.type,
              toolName: message.toolName,
              keys: Object.keys(message),
              soloSteer: JSON.stringify(message).includes("SOLO_STEER"),
              privateCanary: JSON.stringify(message).includes("PRIVATE_AUTHORITY_CANARY"),
            })),
          }),
      );
      return observed;
    };
    const send = (client: GatewayClient, key: string, message: string) =>
      client.request<{ runId: string; status: string }>("chat.send", {
        sessionKey: key,
        message,
        idempotencyKey: randomUUID(),
        deliver: false,
      });
    const waitRun = async (runId: string) => {
      expect(
        await withinTest(
          terminalFor(runId).promise,
          AbortSignal.any([signal, AbortSignal.timeout(130_000)]),
        ),
      ).toEqual({ state: "final" });
      const result = await high.request<{ status: string }>("agent.wait", {
        runId,
        timeoutMs: 130_000,
      });
      expect(result).toMatchObject({ status: "ok" });
    };
    const waitQueued = async (runId: string) => {
      const receipt = await high.request("agent.wait", { runId, timeoutMs: 130_000 });
      expect(receipt).toMatchObject({
        status: "pending",
        timeoutPhase: "queue",
        providerStarted: false,
      });
      return receipt;
    };
    const create = async (name: string) => {
      const key = "agent:main:dashboard:" + name + "-" + randomUUID();
      const created = await high.request<{ key: string }>("sessions.create", {
        key,
        agentId: "main",
        visibility: "shared",
      });
      expect(created.key).toBe(key);
      for (const client of [low, third]) {
        const { profile: user } = await client.request<{ profile: { id: string } }>(
          "users.self",
          {},
        );
        await high.request("session.members.add", { sessionKey: key, identityId: user.id });
      }
      await low.request("chat.history", { sessionKey: key });
      await third.request("chat.history", { sessionKey: key });
      return key;
    };
    const caseRun = async (name: string, body: () => Promise<unknown>) => {
      if (selectedCases && !selectedCases.test(name)) {
        ledger.push({ name, outcome: "not-selected" });
        return;
      }
      try {
        const facts = await body();
        ledger.push({ name, outcome: "passed", facts });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(name + ": " + message);
        ledger.push({
          name,
          outcome: "failed",
          facts: {
            message,
            ...(error instanceof Error && "actual" in error ? { actual: error.actual } : {}),
          },
        });
      } finally {
        relay.releaseAll();
        console.error("[quiet-live] " + JSON.stringify(ledger.at(-1)));
      }
    };
    try {
      await instance.state.writeConfig(config);
      await fs.writeFile(
        path.join(instance.state.workspaceDir, "report.txt"),
        "Synthetic report: launch readiness is green; two checks remain.\n",
      );
      await instance.startGateway();
      await new Promise<void>((resolve, reject) => {
        front.once("error", reject);
        front.listen(frontClaim.port, "127.0.0.1", resolve);
      });
      high = await connect(0);
      low = await connect(1);
      third = await connect(2);
      const identities = await Promise.all(
        [high, low, third].map((client) =>
          client.request<{ profile: { id: string } }>("users.self", {}),
        ),
      );
      expect(new Set(identities.map((x) => x.profile.id)).size).toBe(3);
      const lowIdentity = identities[1];
      const thirdIdentity = identities[2];
      if (!lowIdentity || !thirdIdentity) {
        throw new Error("Missing authenticated fixture identity");
      }
      for (const identity of [lowIdentity, thirdIdentity]) {
        await high.request("users.setRole", { profileId: identity.profile.id, role: "low" });
      }
      low = await connect(1);
      third = await connect(2);
      console.error(
        "[quiet-live] principals " + JSON.stringify(identities.map((x) => x.profile.id)),
      );
      const warm = await create("warmup");
      await waitRun((await send(high, warm, "Do not use tools. Reply exactly READY.")).runId);
      const warmHistory = await history(warm);
      expect(JSON.stringify(warmHistory.messages)).toContain("READY");
      expect(warmHistory.messages).toContainEqual(
        expect.objectContaining({ role: "assistant", provider: "openai", model: "gpt-5.4" }),
      );
      console.error(
        "[quiet-live] real Gateway/provider warmup completed; pid=" + instance.child?.pid,
      );

      await caseRun("same requester input during preparation reaches model", async () => {
        const key = await create("preparation");
        const gate = relay.armPreparation();
        const offset = relay.requests.length;
        const root = await send(
          high,
          key,
          "First use read on report.txt. Then reply with PREPARATION_FIRST and follow any additional user instruction.",
        );
        const request = await withinTest(gate.entered.promise, signal);
        expect(request.model).toBe("gpt-5.4");
        expect(request.tools).toBeUndefined();
        const early = await send(
          high,
          key,
          "Additional instruction: also include EARLY_PREPARATION_ANSWER in your final response. Do not use tools.",
        );
        const pending = await history(key, [early.runId]);
        console.error(
          "[preparation-proof] admitted " +
            JSON.stringify({
              root: root.runId,
              input: early.runId,
              receipt: pending.inputReceipts,
              requestKeys: Object.keys(request),
            }),
        );
        gate.release.resolve();
        await waitRun(root.runId);
        await waitRun(early.runId);
        const after = await history(key, [early.runId]);
        const calls = relay.requests.slice(offset).map((call) => ({
          tools: Array.isArray(call.tools),
          earlyInput: JSON.stringify(call.input).includes("EARLY_PREPARATION_ANSWER"),
        }));
        const answers = after.messages
          .filter((message) => message.role === "assistant")
          .map(safeAssistantText);
        console.error(
          "[preparation-proof] completed " +
            JSON.stringify({ calls, answers, receipts: after.inputReceipts }),
        );
        expect(calls.some((call) => call.tools && call.earlyInput)).toBe(true);
        expect(answers.some((answer) => answer.includes("EARLY_PREPARATION_ANSWER"))).toBe(true);
        return {
          root: root.runId,
          input: early.runId,
          calls,
          answers,
          receipt: after.inputReceipts,
        };
      });

      await caseRun("solo compatible steer", async () => {
        const key = await create("solo");
        const gate = relay.arm();
        const root = await send(
          high,
          key,
          "First use read on report.txt. Then reply with SOLO_FIRST and follow any additional user instruction.",
        );
        const request = await withinTest(gate.entered.promise, signal);
        expect(request.model).toBe("gpt-5.4");
        const steer = await send(
          high,
          key,
          "Additional instruction: also include SOLO_STEER in your final response. Do not use tools.",
        );
        const pending = await history(key, [steer.runId]);
        expect(pending.inputReceipts?.find((x) => x.runId === steer.runId)?.queued).not.toBe(true);
        gate.release.resolve();
        await waitRun(root.runId);
        await waitRun(steer.runId);
        const after = await history(key, [steer.runId]);
        expect(
          relay.requests.some((call) => JSON.stringify(call.input).includes("SOLO_STEER")),
        ).toBe(true);
        expect(JSON.stringify(after.messages)).toContain("SOLO_STEER");
        return { root: root.runId, input: steer.runId, receipt: after.inputReceipts };
      });

      for (const [name, incumbent, incoming, second, duplicate] of [
        ["high owner low incoming identical", () => high, () => low, () => third, true],
        ["low incumbent high incoming differing", () => low, () => high, () => third, false],
      ] as const) {
        await caseRun(name, async () => {
          const key = await create(duplicate ? "identical" : "different");
          const gate = relay.arm();
          const root = await send(incumbent(), key, "Do not use tools. Reply exactly ROOT_DONE.");
          await withinTest(gate.entered.promise, signal);
          const a = await send(incoming(), key, "Summarize report.txt");
          const b = await send(
            second(),
            key,
            duplicate
              ? "Summarize report.txt"
              : "Read report.txt and list the two remaining checks. Reply with DIFFERENT_REQUEST.",
          );
          expect(a.runId).not.toBe(b.runId);
          await waitQueued(a.runId);
          await waitQueued(b.runId);
          const queued = await history(key, [a.runId, b.runId]);
          expect(queued.inputReceipts).toEqual(
            [a, b].map((x) => expect.objectContaining({ runId: x.runId, state: "pending" })),
          );
          expect(queued.inFlightRun?.runId).toBe(root.runId);
          gate.release.resolve();
          await waitRun(root.runId);
          await waitRun(a.runId);
          await waitRun(b.runId);
          const after = await history(key, [a.runId, b.runId]);
          expect(
            after.pendingInputs?.items.filter(
              (x) => [a.runId, b.runId].includes(x.runId ?? "") && x.state === "queued",
            ),
          ).toEqual([]);
          const terminalEvents = events
            .filter((x) => x.event === "chat")
            .map((x) => x.payload as { runId: string; state: string })
            .filter((x) => [root.runId, a.runId, b.runId].includes(x.runId) && x.state === "final");
          expect(terminalEvents.map((x) => x.runId)).toEqual([root.runId, a.runId, b.runId]);
          const text = JSON.stringify(after.messages);
          expect(text).not.toContain("wasn’t queued");
          expect(text).not.toContain("will run after");
          const visible = text + JSON.stringify(events);
          expect(visible).not.toContain("/followup");
          expect(visible).not.toContain("Your message is queued");
          for (const client of [incoming(), second()]) {
            const self = await client.request<{ profile: { id: string } }>("users.self", {});
            expect(text).toContain(self.profile.id);
          }
          return {
            root: root.runId,
            queued: [a.runId, b.runId],
            terminals: terminalEvents.map((x) => x.runId),
            receipts: after.inputReceipts,
          };
        });
      }

      await caseRun("current policy retained at queued execution", async () => {
        const key = await create("current-policy");
        const gate = relay.arm();
        const root = await send(high, key, "Do not use tools. Reply ROOT_POLICY.");
        await withinTest(gate.entered.promise, signal);
        const queued = await send(low, key, "Do not use tools. Reply POLICY_SHOULD_NOT_EXECUTE.");
        await waitQueued(queued.runId);
        expect((await history(key, [queued.runId])).inputReceipts).toContainEqual(
          expect.objectContaining({ runId: queued.runId, state: "pending" }),
        );
        const before = relay.requests.length;
        await high.request("users.setRole", {
          profileId: lowIdentity.profile.id,
          role: "blocked",
        });
        gate.release.resolve();
        await waitRun(root.runId);
        const result = await high.request<{ status: string }>("agent.wait", {
          runId: queued.runId,
          timeoutMs: 130_000,
        });
        await high.request("users.setRole", { profileId: lowIdentity.profile.id, role: "low" });
        low = await connect(1);
        expect(result.status).not.toBe("ok");
        expect(
          relay.requests
            .slice(before)
            .some((x) => JSON.stringify(x.input).includes("POLICY_SHOULD_NOT_EXECUTE")),
        ).toBe(false);
        return {
          queued: queued.runId,
          settlement: result.status,
          additionalProviderRequests: relay.requests.length - before,
        };
      });

      await caseRun("cancel queued input", async () => {
        const key = await create("cancel");
        const gate = relay.arm();
        const root = await send(high, key, "Do not use tools. Reply CANCEL_ROOT.");
        await withinTest(gate.entered.promise, signal);
        const queued = await send(
          third,
          key,
          "Do not use tools. Reply CANCELLED_INPUT_MUST_NOT_EXECUTE.",
        );
        await waitQueued(queued.runId);
        expect((await history(key, [queued.runId])).inputReceipts).toContainEqual(
          expect.objectContaining({ runId: queued.runId, state: "pending" }),
        );
        const aborted = await high.request<{ aborted: boolean }>("chat.abort", {
          sessionKey: key,
          runId: queued.runId,
        });
        expect(aborted.aborted).toBe(true);
        gate.release.resolve();
        await waitRun(root.runId);
        const after = await history(key, [queued.runId]);
        expect(after.inputReceipts).toContainEqual(
          expect.objectContaining({ runId: queued.runId, state: "pending", cancelled: true }),
        );
        expect(after.inputReceipts).not.toContainEqual(
          expect.objectContaining({ runId: queued.runId, state: "consumed" }),
        );
        expect(
          relay.requests.some((x) =>
            JSON.stringify(x.input).includes("CANCELLED_INPUT_MUST_NOT_EXECUTE"),
          ),
        ).toBe(false);
        return { input: queued.runId, aborted, receipts: after.inputReceipts };
      });

      const restrictedKey = "agent:main:dashboard:private-" + randomUUID();
      await high.request("sessions.create", {
        key: restrictedKey,
        agentId: "main",
        visibility: "draft",
      });
      await high.request("chat.inject", {
        sessionKey: restrictedKey,
        message: "PRIVATE_AUTHORITY_CANARY",
      });
      await expect(low.request("chat.history", { sessionKey: restrictedKey })).rejects.toThrow();
      const authorityCase = async (collaborative: boolean, highIncumbent: boolean) => {
        const key = await create("authority");
        const gate = relay.arm();
        const incumbent = highIncumbent ? high : low;
        const incoming = highIncumbent ? low : high;
        const root = await send(
          incumbent,
          key,
          "First use read on report.txt. Then reply AUTHORITY_ROOT and follow any additional user instruction.",
        );
        const request = await withinTest(gate.entered.promise, signal);
        expect(request.tools).toContainEqual(
          expect.objectContaining({ name: "sessions_history", strict: false }),
        );
        const admitted = await send(
          incoming,
          key,
          "Use sessions_history exactly once with these exact arguments: " +
            JSON.stringify({ sessionKey: restrictedKey, limit: 5 }) +
            ". Omit user to use the turn's original requester. Omit messageId, sessionId, offset, pendingBefore and all other optional arguments; do not invent IDs. " +
            "Report whether access succeeded; do not use read or any other tool.",
        );
        if (!collaborative) {
          await waitQueued(admitted.runId);
        }
        const pending = await history(key, [admitted.runId]);
        if (!collaborative) {
          expect(pending.inputReceipts).toContainEqual(
            expect.objectContaining({ runId: admitted.runId, state: "pending" }),
          );
        } else {
          expect(pending.inputReceipts?.find((x) => x.runId === admitted.runId)?.queued).not.toBe(
            true,
          );
        }
        gate.release.resolve();
        await waitRun(root.runId);
        await waitRun(admitted.runId);
        const after = await history(key, [admitted.runId]);
        const results = after.messages.filter(
          (message) => message.role === "toolResult" && message.toolName === "sessions_history",
        );
        expect(results.length).toBeGreaterThan(0);
        const calls = after.messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter(
                (block) => block.type === "toolCall" && block.name === "sessions_history",
              )
            : [],
        );
        expect(calls.map((call) => call.arguments)).toEqual([
          { sessionKey: restrictedKey, limit: 5 },
        ]);
        const text = JSON.stringify(results);
        const allowed = collaborative ? highIncumbent : !highIncumbent;
        if (allowed) {
          expect(text).toContain("PRIVATE_AUTHORITY_CANARY");
        } else {
          expect(text).not.toContain("PRIVATE_AUTHORITY_CANARY");
          expect(text).toMatch(
            /forbidden|denied|not allowed|restricted|not visible|not found|no session found/i,
          );
        }
        return {
          root: root.runId,
          input: admitted.runId,
          collaborative,
          highIncumbent,
          toolAccess: allowed ? "allowed" : "denied",
          receipt: after.inputReceipts,
        };
      };
      for (const highIncumbent of [true, false]) {
        await caseRun("queued input uses incoming authority; high incumbent=" + highIncumbent, () =>
          authorityCase(false, highIncumbent),
        );
      }
      const restartQueue = async (
        collaborative: boolean | undefined,
        fallback: "queue" | "reject",
      ) => {
        for (const client of clients) {
          await client.stopAndWait();
        }
        await instance.stopGateway();
        config.messages = {
          queue: {
            ...(collaborative !== undefined ? { allowCollaborativeSteering: collaborative } : {}),
            collaborativeSteeringFallback: fallback,
          },
        };
        await instance.state.writeConfig(config);
        await instance.startGateway();
        high = await connect(0);
        low = await connect(1);
        third = await connect(2);
      };
      await restartQueue(false, "reject");
      await caseRun("strict opt-in reject", async () => {
        const key = await create("strict");
        const gate = relay.arm();
        const root = await send(high, key, "Do not use tools. Reply STRICT_ROOT.");
        await withinTest(gate.entered.promise, signal);
        const rejected = await send(third, key, "STRICT_REJECTED_INPUT");
        // A strict rejection is a visible terminal disposition, not queued work.
        expect(await withinTest(terminalFor(rejected.runId).promise, signal)).toEqual({
          state: "final",
        });
        const refusal = await high.request<{ status: string }>("agent.wait", {
          runId: rejected.runId,
          timeoutMs: 130_000,
        });
        expect(refusal.status).toBe("error");
        const before = await history(key, [rejected.runId]);
        expect(before.inputReceipts).not.toContainEqual(
          expect.objectContaining({ runId: rejected.runId, queued: true }),
        );
        gate.release.resolve();
        await waitRun(root.runId);
        expect(
          relay.requests.some((x) => JSON.stringify(x.input).includes("STRICT_REJECTED_INPUT")),
        ).toBe(false);
        expect(JSON.stringify((await history(key)).messages)).toContain(
          "collaborative steering is disabled",
        );
        return { rejected: rejected.runId, receipt: before.inputReceipts };
      });
      // Exercise the public default without an explicit collaboration override.
      await restartQueue(undefined, "queue");
      for (const highIncumbent of [true, false]) {
        await caseRun(
          "collaborative steer intentionally retains incumbent authority; high incumbent=" +
            highIncumbent,
          () => authorityCase(true, highIncumbent),
        );
      }
      await restartQueue(false, "queue");

      await caseRun("cold Gateway process restart with queued input", async () => {
        const key = await create("cold");
        const gate = relay.arm();
        const root = await send(high, key, "Do not use tools. Reply COLD_ROOT.");
        await withinTest(gate.entered.promise, signal);
        const queued = await send(third, key, "Do not use tools. Reply COLD_QUEUED_RECOVERED.");
        await waitQueued(queued.runId);
        const before = await history(key, [queued.runId]);
        expect(before.inputReceipts).toContainEqual(
          expect.objectContaining({ runId: queued.runId, state: "pending" }),
        );
        const oldPid = instance.child?.pid;
        await instance.crashGateway();
        for (const client of clients) {
          await client.stopAndWait();
        }
        gate.release.resolve();
        await instance.stopGateway();
        await instance.startGateway();
        expect(instance.child?.pid).not.toBe(oldPid);
        high = await connect(0);
        low = await connect(1);
        third = await connect(2);
        const recovered = await history(key, [queued.runId]);
        console.error(
          "[quiet-live] cold-boundary " +
            JSON.stringify({
              oldPid,
              newPid: instance.child?.pid,
              receipts: recovered.inputReceipts,
              pending: recovered.pendingInputs,
            }),
        );
        await waitRun(queued.runId);
        const after = await history(key, [queued.runId]);
        expect(
          after.pendingInputs?.items.filter(
            (input) => input.runId === queued.runId && input.state === "queued",
          ),
        ).toEqual([]);
        expect(
          after.messages
            .filter((message) => message.role === "assistant")
            .map(safeAssistantText)
            .join("\n"),
        ).toContain("COLD_QUEUED_RECOVERED");
        return {
          root: root.runId,
          oldPid,
          newPid: instance.child?.pid,
          receipts: after.inputReceipts,
        };
      });
      expect(relay.failures).toEqual([]);
      expect(failures).toEqual([]);
    } finally {
      relay.releaseAll();
      await runQaGatewayFixture(
        async () => {
          for (const client of clients) {
            await client.stopAndWait();
          }
        },
        () => instance.cleanup(),
        () => {
          for (const socket of sockets) {
            socket.destroy();
          }
        },
        () =>
          new Promise<void>((resolve) => {
            front.close(() => resolve());
          }),
        () => frontClaim.release(),
        () => relay.close(),
      );
      console.error(
        "[quiet-live] final " +
          JSON.stringify({
            model: MODEL,
            ledger,
            providerRequests: relay.requests.length,
            providerShapes: relay.requests.map((call) => ({
              keys: Object.keys(call),
              hasSoloSteer: JSON.stringify(call).includes("SOLO_STEER"),
              hasPrivateCanary: JSON.stringify(call).includes("PRIVATE_AUTHORITY_CANARY"),
            })),
            cleanup: "owned Gateway stopped and fixture state removed",
          }),
      );
    }
  }, 900_000);
});
