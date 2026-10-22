import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import path from "node:path";
import { expect, test } from "vitest";
import {
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../extensions/qa-lab/api.js";
import { listConversations } from "../src/config/sessions/conversation-registry.js";
import type { GatewaySessionRow } from "../src/gateway/session-utils.types.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

function expectHistory(
  text: string | undefined,
  included: number[],
  excluded: number[],
  suffix = "",
) {
  for (const turn of included) {
    expect(text).toContain(`HISTORY_TURN_${turn}${suffix}`);
  }
  for (const turn of excluded) {
    expect(text).not.toContain(`HISTORY_TURN_${turn}${suffix}`);
  }
}

async function runAccountHistoryProof(compactionMode: "client" | "server-endpoint") {
  const model = await startQaMockOpenAiServer({ modelRefs: ["history-proof/history-proof"] });
  const replies: string[] = [];
  const compactRequests: string[] = [];
  const checkpoint = (generation: number) => ({
    type: "compaction",
    id: `cmp_history_${generation}`,
    encrypted_content: `HISTORY_ENDPOINT_CHECKPOINT_${generation}`,
    created_by: `history-proof-${generation}`,
  });
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  let poll: ServerResponse | undefined;
  const respond = (response: ServerResponse, result: unknown) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
  };
  const transport = createServer((request, response) => {
    if (request.url?.startsWith("/v1/") && request.url !== "/v1/responses/compact") {
      const upstream = httpRequest(
        new URL(request.url, model.baseUrl),
        {
          method: request.method,
          headers: request.headers,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 500, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on("error", (error) => response.writeHead(502).end(String(error)));
      request.pipe(upstream);
      return;
    }
    void (async () => {
      const method = request.url?.split("/").at(-1);
      if (method === "getUpdates") {
        poll = response;
        response.on("close", () => {
          if (poll === response) {
            poll = undefined;
          }
        });
        return;
      }
      if (method === "getMe") {
        respond(response, {
          id: 424242,
          is_bot: true,
          first_name: "History",
          username: "history_proof_bot",
        });
        return;
      }
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
      }
      if (request.url === "/v1/responses/compact") {
        compactRequests.push(raw);
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "response.compaction",
            output: [checkpoint(compactRequests.length)],
            usage: { input_tokens: 1000, output_tokens: 50 },
          }),
        );
        return;
      }
      const body = raw ? (JSON.parse(raw) as { text?: string; chat_id?: number }) : {};
      if (method === "sendMessage") {
        replies.push(body.text ?? "");
        respond(response, {
          message_id: replies.length + 100,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "private" },
          text: body.text,
        });
        return;
      }
      respond(response, true);
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => {
    transport.listen(0, "127.0.0.1", resolve);
  });
  const address = transport.address();
  if (!address || typeof address === "string") {
    throw new Error("Telegram fixture did not bind");
  }
  const { config: provider } = buildMockOpenAiResponsesProvider(
    `http://127.0.0.1:${address.port}/v1`,
    "history-proof",
  );
  provider.apiKey = "test-token-placeholder";
  provider.models[0].name = "History proof";
  provider.request = { allowPrivateNetwork: true };
  const instance = await createOpenClawTestInstance({
    name: "account-history",
    config: {
      plugins: { slots: { memory: "none" } },
      agents: {
        defaults: {
          model: { primary: "history-proof/history-proof" },
          models: {
            "history-proof/history-proof": {
              agentRuntime: { id: "openclaw" },
              ...(compactionMode === "server-endpoint"
                ? { params: { responsesCompactEndpoint: true } }
                : {}),
            },
          },
          skipBootstrap: true,
          skills: [],
          compaction: {
            mode: "default",
            keepRecentTokens: 1,
            recentTurnsPreserve: 0,
            memoryFlush: { enabled: false },
          },
        },
      },
      tools: { profile: "minimal" },
      messages: { visibleReplies: "automatic" },
      session: {
        dmScope: "per-channel-peer",
        identityLinks: { "direct:peer": ["telegram:123"] },
      },
      channels: {
        telegram: {
          enabled: true,
          defaultAccount: "direct",
          apiRoot: `http://127.0.0.1:${address.port}`,
          dmHistoryLimit: 20,
          commands: { native: false, nativeSkills: false },
          streaming: { mode: "off" },
          accounts: {
            direct: {
              botToken: "424242:TEST_TOKEN_PLACEHOLDER_FOR_LOCAL_GATEWAY",
              dmPolicy: "allowlist",
              allowFrom: ["123"],
              dmHistoryLimit: 10,
              // Telegram's channel context uses the native ID; the embedded
              // transcript historically uses the linked session peer.
              dms: {
                "123": { historyLimit: 2 },
                "direct:peer": { historyLimit: 2 },
                peer: { historyLimit: 6 },
              },
            },
          },
        },
      },
      models: {
        mode: "replace",
        providers: { "history-proof": provider },
      },
    },
    env: {
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
    },
  });
  let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  try {
    await instance.startGateway();
    const gateway = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    client = gateway;
    const key = "agent:main:telegram:direct:direct:peer";
    const sendTurn = async (turn: number) => {
      await expect.poll(() => Boolean(poll), { timeout: 30000 }).toBe(true);
      const currentPoll = poll!;
      poll = undefined;
      respond(currentPoll, [
        {
          update_id: turn,
          message: {
            message_id: turn,
            date: Math.floor(Date.now() / 1000),
            from: { id: 123, is_bot: false, first_name: "Fixture" },
            chat: { id: 123, type: "private", first_name: "Fixture" },
            text: `HISTORY_TURN_${turn}. Reply exactly: ACK_${turn}`,
          },
        },
      ]);
      await expect
        .poll(() => replies.some((reply) => reply.includes(`ACK_${turn}`)), { timeout: 30000 })
        .toBe(true);
      // Telegram receives the ACK before delivery cleanup releases the session.
      await expect
        .poll(
          async () =>
            (
              await gateway.request<{ session: GatewaySessionRow | null }>("sessions.describe", {
                key,
              })
            ).session,
          { timeout: 30000 },
        )
        .toMatchObject({ hasActiveRun: false, status: "done" });
    };
    for (let turn = 1; turn <= 6; turn++) {
      await sendTurn(turn);
    }
    const requests = async () =>
      (await fetch(`${model.baseUrl}/debug/requests`).then((response) =>
        response.json(),
      )) as MockOpenAiRequestSnapshot[];
    const latestPrompt = async () =>
      (await requests()).findLast((request) => request.requestKind === "agent-initial")!;
    expectHistory((await latestPrompt()).allInputText, [6], [1, 2]);
    const listed = await client.request<{ sessions: Array<{ key: string; sessionId: string }> }>(
      "sessions.list",
      { limit: 20 },
    );
    const session = listed.sessions.find((entry) => entry.key === key);
    expect(session).toBeDefined();
    const conversation = (
      await listConversations({
        agentId: "main",
        storePath: path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
      })
    ).find(
      (entry) =>
        entry.sessionKey === key &&
        entry.sessionId === session!.sessionId &&
        entry.role === "primary",
    );
    expect(conversation).toMatchObject({
      accountId: "direct",
      kind: "direct",
      routeContext: { peerId: "123" },
    });
    const compacted = await client.request<{
      ok: boolean;
      compacted: boolean;
      result?: { summary?: string; kind?: string };
    }>("sessions.compact", { key }, { timeoutMs: 60000 });
    expect(compacted).toMatchObject({ ok: true, compacted: true });
    if (compactionMode === "server-endpoint") {
      expect(compacted.result?.kind).toBe("server-endpoint");
      expect(compactRequests).toHaveLength(1);
      expectHistory(compactRequests[0], [5, 6], [1, 2]);
      for (let generation = 1; generation <= 2; generation++) {
        const firstTurn = generation * 6 + 1;
        for (let turn = firstTurn; turn < firstTurn + 6; turn++) {
          await sendTurn(turn);
          const replay = await latestPrompt();
          const body = JSON.parse(replay.raw) as { input: Array<{ type?: string }> };
          const checkpoints = body.input.filter((item) => item.type === "compaction");
          expect(checkpoints).toHaveLength(1);
          expect(hash(checkpoints)).toBe(hash([checkpoint(generation)]));
          if (turn === firstTurn + 5) {
            expectHistory(replay.allInputText, [], [firstTurn, firstTurn + 1], ".");
          }
        }
        if (generation === 1) {
          const next = await client.request<{ result?: { kind?: string } }>(
            "sessions.compact",
            { key },
            { timeoutMs: 60000 },
          );
          expect(next.result?.kind).toBe("server-endpoint");
          expect(compactRequests).toHaveLength(2);
          expect(compactRequests[1]).toContain(checkpoint(1).encrypted_content);
          expectHistory(compactRequests[1], [], [5, 6], ".");
        }
      }
      return;
    }
    expect(compactRequests).toHaveLength(0);
    const summary = (await requests()).filter(
      (request) => request.requestKind === "compaction-summary",
    );
    expect(summary.length).toBeGreaterThan(0);
    const summaryInput = summary.map((request) => request.allInputText).join("\n");
    // Compaction preserves older durable context, rather than treating a prompt
    // window as deletion. Its saved summary survives subsequent history cuts.
    expectHistory(summaryInput, [5, 1, 4], []);
    expect(compacted.result?.summary).toBeTruthy();
    for (let turn = 7; turn <= 12; turn++) {
      await sendTurn(turn);
    }
    const afterCompaction = await latestPrompt();
    expect(afterCompaction.allInputText).toContain(compacted.result!.summary);
    expectHistory(afterCompaction.allInputText, [12], []);
    expectHistory(afterCompaction.allInputText, [], [7, 8], ".");
  } catch (error) {
    throw new Error(`${String(error)}\n${instance.logs()}`, { cause: error });
  } finally {
    if (client) {
      await disconnectGatewayClient(client);
    }
    await instance.cleanup();
    await model.stop();
    transport.closeAllConnections();
    await new Promise<void>((resolve) => {
      transport.close(() => resolve());
    });
  }
}

test.each(["client", "server-endpoint"] as const)(
  "routes account-scoped history through Gateway prompts and %s compaction",
  runAccountHistoryProof,
  180000,
);
