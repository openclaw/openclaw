// PR #134843: real channel -> Gateway -> model/tool -> recipient/recovery -> channel.
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import type { SessionsListResult } from "../../../../src/gateway/session-utils.types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL = "mock-openai/qa-primary";
const PARENT_KEY = "agent:qa:main";
const CONVERSATION = { id: "qa-operator", kind: "direct" as const };
const RETRY_TEXT = "did not produce a user-visible answer";
const RECOVERED = "PR134843-REASONING-RECOVERED";
type Handoff = "clean" | "reasoning";
type Phase = Handoff | "approval-deny" | "approval-allow";
type RequestKind = "title" | "seed" | "sender" | "recipient" | "reply" | "announce" | "approval";
type ProviderRequest = {
  model: string;
  instructions?: string;
  input: Array<{
    type?: string;
    role?: string;
    call_id?: string;
    output?: string;
    content?: unknown;
  }>;
  [key: string]: unknown;
};
type Receipt = { status: string; runId: string; sessionKey: string; reply?: string };
type Evidence = { phase: Phase; kind: RequestKind; retry: boolean; body: ProviderRequest };

const recipientKey = (mode: Handoff) => `agent:qa:pr134843-${mode}`;
const dispatchPrompt = (mode: Handoff) => `PR134843 dispatch ${mode} handoff.`;
const doneMarker = (mode: Handoff) => `PR134843-${mode.toUpperCase()}-SENDER-DONE`;
const approvalMarker = (phase: Phase) => `PR134843-${phase.toUpperCase()}-RECOVERED`;

function writeTerminal(response: ServerResponse, sequence: number, reasoning = false): void {
  const item = reasoning
    ? {
        type: "reasoning",
        id: `rs_pr134843_${sequence}`,
        summary: [{ type: "summary_text", text: "A visible answer is still needed." }],
      }
    : {
        type: "message",
        id: `msg_pr134843_empty_${sequence}`,
        role: "assistant",
        status: "completed",
        content: [],
      };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_pr134843_${sequence}`,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 1,
          output_tokens: reasoning ? 1 : 0,
          total_tokens: reasoning ? 2 : 1,
        },
      },
    },
  ]);
}

function writeSendCall(response: ServerResponse, mode: Handoff): void {
  const item = {
    type: "function_call",
    id: `fc_pr134843_${mode}`,
    call_id: `call_pr134843_${mode}`,
    name: "sessions_send",
    arguments: JSON.stringify({
      sessionKey: recipientKey(mode),
      message: `PR134843 recipient ${mode} handoff.`,
      timeoutSeconds: 60,
    }),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_pr134843_send_${mode}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function startProofProvider() {
  let phase: Phase = "clean";
  const requests: Evidence[] = [];
  const receipts: Partial<Record<Handoff, Receipt>> = {};
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "qa-primary", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest;
      const system = JSON.stringify([
        body.instructions,
        ...body.input.filter((item) => item.role === "developer" || item.role === "system"),
      ]);
      const lastUser = JSON.stringify(
        body.input.findLast(
          (item) =>
            item.role === "user" &&
            !JSON.stringify(item.content).includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"),
        ),
      );
      const userInput = JSON.stringify(body.input.filter((item) => item.role === "user"));
      const kind: RequestKind = system.includes("Generate a concise session title")
        ? "title"
        : system.includes("Agent-to-agent reply step")
          ? "reply"
          : lastUser.includes("Agent-to-agent announce step")
            ? "announce"
            : phase.startsWith("approval-")
              ? "approval"
              : lastUser.includes("PR134843 seed")
                ? "seed"
                : userInput.includes(`PR134843 recipient ${phase} handoff.`)
                  ? "recipient"
                  : "sender";
      const evidence = {
        phase,
        kind,
        retry: lastUser.includes(RETRY_TEXT) || system.includes(RETRY_TEXT),
        body,
      };
      requests.push(evidence);
      const sequence = requests.length;
      const reply = (text: string) =>
        writeOpenAiResponsesText(response, {
          text,
          messageId: `msg_pr134843_${sequence}`,
          responseId: `resp_pr134843_${sequence}`,
        });
      if (kind === "title" || kind === "seed") {
        reply(kind === "title" ? "Inter-session proof" : "PR134843-SEEDED");
      } else if (kind === "reply" || kind === "announce") {
        reply(kind === "reply" ? "REPLY_SKIP" : "ANNOUNCE_SKIP");
      } else if (kind === "approval" || kind === "recipient") {
        const count = requests.filter(
          (entry) => entry.phase === phase && entry.kind === kind,
        ).length;
        if (count === 1) {
          writeTerminal(response, sequence, phase === "reasoning");
        } else {
          reply(kind === "approval" ? approvalMarker(phase) : RECOVERED);
        }
      } else if (phase === "clean" || phase === "reasoning") {
        const output = body.input.find(
          (item) =>
            item.type === "function_call_output" && item.call_id === `call_pr134843_${phase}`,
        )?.output;
        if (output === undefined) {
          writeSendCall(response, phase);
        } else {
          receipts[phase] = JSON.parse(output) as Receipt;
          reply(doneMarker(phase));
        }
      } else {
        throw new Error(`Unexpected request during ${phase}`);
      }
    })().catch((error: unknown) => {
      errors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    receipts,
    errors,
    setPhase: (next: Phase) => {
      phase = next;
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function proofConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: { ...config.agents?.defaults, heartbeat: { every: "0m" } },
    },
    tools: { ...config.tools, sessions: { visibility: "all" } },
  };
}

describe.runIf(process.env.OPENCLAW_PROOF_INTER_SESSION_EMPTY_REPLY === "1")(
  "inter-session empty replies through the real Gateway",
  () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.splice(0).toReversed()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "inter-session proof cleanup failed");
      }
    });

    it("keeps clean handoffs silent and recovers reasoning and real approval continuations", async () => {
      const provider = await startProofProvider();
      cleanups.push(() => provider.stop());
      const state = createQaBusState();
      const transport = createQaChannelTransport(state);
      const bus = await startQaBusServer({ state });
      cleanups.push(() => bus.stop());
      const owner = createQaGatewayChild();
      cleanups.push(async () => expect((await owner.stop()).errors).toEqual([]));
      console.log(JSON.stringify({ phase: "pr134843-gateway-start" }));
      const gateway = await owner.start({
        repoRoot: REPO_ROOT,
        command: {
          executablePath: process.execPath,
          // Exercise the built Gateway through the upstream QA product-proof entry.
          argsPrefix: ["dist/entry.js"],
          cwd: REPO_ROOT,
          // Stage isolated mock auth and plugins through the source-checkout fixture.
          usePackagedPlugins: false,
        },
        providerBaseUrl: `${provider.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL,
        alternateModel: MODEL,
        forcedRuntime: "openclaw",
        thinkingDefault: "low",
        transport,
        transportBaseUrl: bus.baseUrl,
        controlUiEnabled: false,
        runtimeEnvPatch: {
          OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
        },
        mutateConfig: proofConfig,
      });
      await transport.waitReady({ gateway });
      console.log(JSON.stringify({ phase: "pr134843-gateway-ready" }));
      const approver = await connectGatewayClient({
        url: gateway.wsUrl,
        token: gateway.token,
        clientName: "gateway-client",
        mode: "backend",
        scopes: ["operator.admin"],
        caps: ["exec-approvals"],
      });
      cleanups.push(() => disconnectGatewayClient(approver));
      const outbound = () =>
        state.getSnapshot().messages.filter((message) => message.direction === "outbound");
      const send = (text: string) =>
        transport.sendInbound({
          accountId: "default",
          conversation: CONVERSATION,
          senderId: CONVERSATION.id,
          text,
        });
      const waitIdle = (keys: string[]) =>
        expect
          .poll(
            async () => {
              const result = (await gateway.call("sessions.list", {
                agentId: "qa",
                limit: 100,
              })) as SessionsListResult;
              return keys.map(
                (key) => result.sessions.find((entry) => entry.key === key)?.hasActiveRun,
              );
            },
            { timeout: 60_000 },
          )
          .toEqual(keys.map(() => false));
      const history: Record<string, unknown> = {};
      const approvalIds: string[] = [];

      for (const mode of ["clean", "reasoning"] as const) {
        provider.setPhase(mode);
        console.log(JSON.stringify({ phase: "pr134843-handoff", scenario: mode }));
        const seeded = (await gateway.call("agent", {
          sessionKey: recipientKey(mode),
          message: "PR134843 seed recipient.",
          deliver: false,
          idempotencyKey: `pr134843-seed-${mode}`,
        })) as { runId: string };
        expect(
          await gateway.call("agent.wait", { runId: seeded.runId, timeoutMs: 60_000 }),
        ).toMatchObject({ status: "ok" });
        const sinceIndex = outbound().length;
        await send(dispatchPrompt(mode));
        await transport.waitForOutbound({
          conversation: CONVERSATION,
          sinceIndex,
          textIncludes: doneMarker(mode),
          timeoutMs: 120_000,
        });
        await waitIdle([PARENT_KEY, recipientKey(mode)]);
        history[mode] = await gateway.call("chat.history", { sessionKey: recipientKey(mode) });
      }

      for (const decision of ["deny", "allow-once"] as const) {
        const phase = decision === "deny" ? "approval-deny" : "approval-allow";
        provider.setPhase(phase);
        console.log(JSON.stringify({ phase: "pr134843-approval", decision }));
        const sinceIndex = outbound().length;
        // This registered slash command is the remaining production owner of
        // detached agent approval followups; ordinary model exec now stays inline.
        await send("/export-trajectory");
        let approvalId: string | undefined;
        await expect
          .poll(
            async () => {
              const pending = (await gateway.call("exec.approval.list", {})) as Array<{
                id: string;
              }>;
              approvalId = pending.find((entry) => !approvalIds.includes(entry.id))?.id;
              return approvalId;
            },
            { timeout: 30_000 },
          )
          .toBeTypeOf("string");
        if (!approvalId) {
          throw new Error("trajectory export omitted its approval");
        }
        approvalIds.push(approvalId);
        await approver.request("exec.approval.resolve", { id: approvalId, decision });
        await transport.waitForOutbound({
          conversation: CONVERSATION,
          sinceIndex,
          textIncludes: approvalMarker(phase),
          timeoutMs: 120_000,
        });
        await waitIdle([PARENT_KEY]);
      }
      history.approvals = await gateway.call("chat.history", { sessionKey: PARENT_KEY });
      await disconnectGatewayClient(approver);
      // Freeze only after admitted work and detached reply/announce flows drain.
      await gateway.stop();
      const messages = outbound();
      const requests = provider.requests;
      console.log(
        JSON.stringify({
          phase: "pr134843-real-gateway",
          requests: requests.map(({ phase, kind, retry }) => ({ phase, kind, retry })),
          receipts: provider.receipts,
          approvalDecisions: ["deny", "allow-once"],
          outbound: messages.map((message) => ({
            conversation: message.conversation,
            text: message.text,
            deleted: message.deleted === true,
          })),
        }),
      );
      expect(provider.errors).toEqual([]);
      expect(provider.receipts.clean).toMatchObject({
        status: "no_reply",
        sessionKey: recipientKey("clean"),
      });
      expect(provider.receipts.clean?.reply).toBeUndefined();
      expect(provider.receipts.reasoning).toMatchObject({
        status: "ok",
        reply: RECOVERED,
        sessionKey: recipientKey("reasoning"),
      });
      for (const phase of ["clean", "reasoning", "approval-deny", "approval-allow"] as const) {
        const kind = phase.startsWith("approval-") ? "approval" : "recipient";
        const attempts = requests.filter(
          (request) => request.phase === phase && request.kind === kind,
        );
        expect(attempts, `${phase} provider attempts`).toHaveLength(phase === "clean" ? 1 : 2);
        expect(attempts.map((request) => request.retry)).toEqual(
          phase === "clean" ? [false] : [false, true],
        );
        const expected =
          phase === "clean" || phase === "reasoning" ? doneMarker(phase) : approvalMarker(phase);
        // The bus retains deleted streaming drafts in its audit snapshot.
        expect(
          messages.filter((message) => !message.deleted && message.text === expected),
          `${phase} visible final replies`,
        ).toHaveLength(1);
      }
      expect(JSON.stringify(history.clean)).toContain("sessions_send");
      expect(JSON.stringify(history.reasoning)).toContain(RECOVERED);
      expect(JSON.stringify(history.approvals)).toContain("exec_approval_followup");
      expect(
        messages.some((message) => message.text.includes("couldn't generate a response")),
      ).toBe(false);
      expect(messages.some((message) => message.text.includes(RECOVERED))).toBe(false);
      expect(
        messages.some((message) => /^(NO_REPLY|REPLY_SKIP|ANNOUNCE_SKIP)$/.test(message.text)),
      ).toBe(false);
    }, 400_000);
  },
);
