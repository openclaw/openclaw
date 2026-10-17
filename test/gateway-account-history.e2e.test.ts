import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import {
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../extensions/qa-lab/api.js";
import { listConversations } from "../src/config/sessions/conversation-registry.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  closeHttpServer,
  connectProofClient,
  createModelGatewayProof,
  listenLoopback,
  readRequestText,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";

function expectTurns(text: string, present: number[], absent: (number | string)[] = []) {
  for (const fragment of present) {
    expect(text).toContain(`HISTORY_TURN_${fragment}`);
  }
  for (const fragment of absent) {
    expect(text).not.toContain(`HISTORY_TURN_${fragment}`);
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
  const respond = (response: ServerResponse, result: unknown) =>
    respondJson(response, { ok: true, result });
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
      const raw = await readRequestText(request);
      if (request.url === "/v1/responses/compact") {
        compactRequests.push(raw);
        respondJson(response, {
          object: "response.compaction",
          output: [checkpoint(compactRequests.length)],
          usage: { input_tokens: 1000, output_tokens: 50 },
        });
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
  const origin = await listenLoopback(transport);
  const instance = await createModelGatewayProof({
    name: "account-history",
    baseUrl: `${origin}/v1`,
    modelId: "history-proof",
    config: (base) => {
      const defaults = base.agents!.defaults!;
      defaults.compaction = {
        mode: "default",
        keepRecentTokens: 1,
        recentTurnsPreserve: 0,
        memoryFlush: { enabled: false },
      };
      if (compactionMode === "server-endpoint") {
        defaults.models!["history-proof/history-proof"]!.params = {
          responsesCompactEndpoint: true,
        };
      }
      return {
        ...base,
        messages: { visibleReplies: "automatic" },
        session: {
          dmScope: "per-channel-peer",
          identityLinks: { "direct:peer": ["telegram:123"] },
        },
        channels: {
          telegram: {
            enabled: true,
            defaultAccount: "direct",
            apiRoot: origin,
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
      };
    },
    env: {
      OPENCLAW_SKIP_CHANNELS: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
    },
  });
  let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
  try {
    await instance.startGateway();
    const gateway = await connectProofClient(instance, {
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
        .poll(() => gateway.request("sessions.describe", { key }), { timeout: 30000 })
        .toMatchObject({ session: { hasActiveRun: false, status: "done" } });
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
    const prompt = await latestPrompt();
    expectTurns(prompt.allInputText, [6], [1, 2]);
    const listed = await client.request<{ sessions: Array<{ key: string; sessionId: string }> }>(
      "sessions.list",
      { limit: 20 },
    );
    const session = listed.sessions.find((entry) => entry.key === key);
    expect(
      await listConversations({
        agentId: "main",
        storePath: path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
      }),
    ).toContainEqual(
      expect.objectContaining({
        sessionKey: key,
        sessionId: expectDefined(session, "listed history session").sessionId,
        role: "primary",
        accountId: "direct",
        kind: "direct",
        routeContext: expect.objectContaining({ peerId: "123" }),
      }),
    );
    const compact = () =>
      gateway.request<{
        ok: boolean;
        compacted: boolean;
        result?: { summary?: string; kind?: string };
      }>("sessions.compact", { key }, { timeoutMs: 60000 });
    const compacted = await compact();
    expect(compacted).toMatchObject({ ok: true, compacted: true });
    if (compactionMode === "server-endpoint") {
      expect(compacted.result?.kind).toBe("server-endpoint");
      expect(compactRequests).toHaveLength(1);
      expectTurns(compactRequests[0]!, [5, 6], [1, 2]);
      for (let generation = 1; generation <= 2; generation++) {
        const firstTurn = generation * 6 + 1;
        for (let turn = firstTurn; turn < firstTurn + 6; turn++) {
          await sendTurn(turn);
          const replay = await latestPrompt();
          const body = JSON.parse(replay.raw) as { input: Array<{ type?: string }> };
          const checkpoints = body.input.filter((item) => item.type === "compaction");
          expect(hash(checkpoints)).toBe(hash([checkpoint(generation)]));
          if (turn === firstTurn + 5) {
            expectTurns(replay.allInputText, [], [`${firstTurn}.`, `${firstTurn + 1}.`]);
          }
        }
        if (generation === 1) {
          const next = await compact();
          expect(next.result?.kind).toBe("server-endpoint");
          expect(compactRequests).toHaveLength(2);
          expect(compactRequests[1]).toContain(checkpoint(1).encrypted_content);
          expectTurns(compactRequests[1]!, [], ["5.", "6."]);
        }
      }
      return;
    }
    expect(compactRequests).toHaveLength(0);
    const summary = (await requests()).filter(
      (request) => request.requestKind === "compaction-summary",
    );
    const summaryInput = summary.map((request) => request.allInputText).join("\n");
    // Compaction preserves older durable context, rather than treating a prompt
    // window as deletion. Its saved summary survives subsequent history cuts.
    expectTurns(summaryInput, [5, 1, 4]);
    expect(compacted.result?.summary).toBeTruthy();
    for (let turn = 7; turn <= 12; turn++) {
      await sendTurn(turn);
    }
    const afterCompaction = await latestPrompt();
    expect(afterCompaction.allInputText).toContain(compacted.result!.summary);
    expectTurns(afterCompaction.allInputText, [12], ["7.", "8."]);
  } catch (error) {
    throw new Error(`${String(error)}\n${instance.logs()}`, { cause: error });
  } finally {
    if (client) {
      await disconnectGatewayClient(client);
    }
    await instance.cleanup();
    await model.stop();
    await closeHttpServer(transport).catch(() => undefined);
  }
}

test.each(["client", "server-endpoint"] as const)(
  "routes account-scoped history through Gateway prompts and %s compaction",
  runAccountHistoryProof,
  180000,
);
