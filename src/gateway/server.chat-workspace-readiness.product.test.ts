// Load the deferred Gateway and model runtime during collection, outside the authority deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import * as workspaceReadiness from "../agents/workspace-readiness.js";
import { requireGit } from "../agents/worktrees/git.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import type { CreateManagedWorktreeParams } from "../agents/worktrees/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { waitForSessionRunEnd } from "../sessions/session-controller.native-runtime.js";
import type { Deferred } from "../shared/deferred.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type ProviderCall = { body: Record<string, unknown>; response: ServerResponse };
type PromptFacts = Parameters<NonNullable<CreateManagedWorktreeParams["onPromptReady"]>>[0];
type CheckoutGate = {
  key: string;
  entered: Deferred<PromptFacts>;
  release: Deferred;
  toolWaiting: Deferred;
  settled: Deferred;
  failure?: Error;
};

const instruction = "WORKTREE_PROMPT_MARKER: preserve this committed project instruction.";
const fileContents = "WORKTREE_TOOL_MARKER: the complete checkout is ready.\n";
const userMessage = "Read src/remaining.txt and report its marker.";
const partial = "I can start while the workspace finishes.";
const assistantMessage = {
  type: "message",
  id: "msg_readiness",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: partial, annotations: [] }],
};

function writeEvent(response: ServerResponse, type: string, fields: Record<string, unknown>) {
  response.write(`data: ${JSON.stringify({ type: `response.${type}`, ...fields })}\n\n`);
}

function finishText(response: ServerResponse, text: string, id: string) {
  writeOpenAiResponsesText(response, { text, messageId: `msg_${id}`, responseId: `resp_${id}` });
}

function finishWithTool(response: ServerResponse, name: string, args: Record<string, unknown>) {
  const item = {
    type: "function_call",
    id: "fc_read_remaining",
    call_id: "call_read_remaining",
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeTextEvent(response, "done", { text: partial });
  writeEvent(response, "output_item.done", { output_index: 0, item: assistantMessage });
  writeEvent(response, "output_item.added", { output_index: 1, item: { ...item, arguments: "" } });
  writeEvent(response, "function_call_arguments.done", {
    item_id: item.id,
    output_index: 1,
    arguments: item.arguments,
  });
  writeEvent(response, "output_item.done", { output_index: 1, item });
  writeEvent(response, "completed", {
    response: {
      id: "resp_read_remaining",
      status: "completed",
      output: [assistantMessage, item],
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
    },
  });
  response.end("data: [DONE]\n\n");
}

function writeTextEvent(response: ServerResponse, phase: string, fields: Record<string, unknown>) {
  writeEvent(response, `output_text.${phase}`, {
    item_id: assistantMessage.id,
    output_index: 0,
    content_index: 0,
    ...fields,
  });
}

async function writeRecordingChannel(root: string, captureUrl: string) {
  const id = "readiness-chat";
  const schema = { type: "object", additionalProperties: false };
  await fs.mkdir(root, { recursive: true });
  const writeJson = (file: string, value: unknown) =>
    fs.writeFile(path.join(root, file), JSON.stringify(value));
  await writeJson("package.json", {
    name: id,
    version: "1.0.0",
    openclaw: { extensions: ["./index.cjs"] },
  });
  await writeJson("openclaw.plugin.json", {
    id,
    channels: [id],
    activation: { onStartup: true },
    channelConfigs: {
      [id]: { schema: { ...schema, properties: { enabled: { type: "boolean" } } } },
    },
    configSchema: schema,
  });
  await fs.writeFile(
    path.join(root, "index.cjs"),
    `
const id = "readiness-chat";
async function send(ctx) {
  const bytes = ctx.mediaUrl ? await ctx.mediaReadFile(ctx.mediaUrl) : Buffer.alloc(0);
  ctx.signal?.throwIfAborted();
  await ctx.onPlatformSendDispatch?.();
  ctx.assertDirectAdapterHandoff?.();
  const response = await fetch(${JSON.stringify(captureUrl)}, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: ctx.to, text: ctx.text, contents: bytes.toString("utf8") }),
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error("Synthetic capture refused delivery");
  await response.text();
  return { channel: id, messageId: ctx.to };
}
module.exports = { id, register(api) {
  api.registerChannel({ plugin: {
    id, meta: { id, label: id, selectionLabel: id, docsPath: "/channels", blurb: "Synthetic recording channel" },
    capabilities: { chatTypes: ["direct"], media: true },
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({ accountId: "default", enabled: true }), isConfigured: () => true },
    messaging: { normalizeTarget: (raw) => raw.trim(), targetResolver: { looksLikeId: (raw) => raw.trim().length > 0 } },
    outbound: { deliveryMode: "direct", resolveTarget: ({to}) => ({ ok: true, to }), sendText: send, sendMedia: send },
  } });
} };
`,
  );
  return root;
}

function promptPrefix(
  body: Record<string, unknown>,
  workspace: string,
  branch: string,
  sessionKey: string,
) {
  const input = Array.isArray(body.input) ? body.input : [];
  return JSON.stringify(
    {
      instructions: body.instructions,
      systemMessages: input.filter(
        (item) => isRecord(item) && (item.role === "system" || item.role === "developer"),
      ),
      tools: body.tools,
    },
    (_key, value: unknown) =>
      typeof value === "string"
        ? value
            .replaceAll(workspace, "<worktree>")
            .replaceAll(branch, "<branch>")
            .replaceAll(sessionKey, "<session>")
            .replaceAll(encodeURIComponent(sessionKey), "<session>")
        : value,
  );
}

it(
  "starts inference before checkout, preserves the prompt, and fences revoked workspace effects",
  { timeout: 90_000 },
  async ({ signal }) => {
    const state = await createProductState("chat-worktree-readiness");
    const repo = state.workspaceDir;
    let providerCalls = 0;
    const deliveries: Array<Record<string, unknown>> = [];
    const failures: unknown[] = [];
    const terminalErrors: Array<string | undefined> = [];
    let nextCall = createDeferred<ProviderCall>();
    let activeGate: CheckoutGate | undefined;
    const firstDelta = createDeferred();
    const failedTurn = createDeferred();
    const runEmbeddedAgent = embeddedAgent.runEmbeddedAgent;
    const modelObserver = vi
      .spyOn(embeddedAgent, "runEmbeddedAgent")
      .mockImplementation(async (params) => {
        if (params.sessionKey !== "agent:main:readiness-failure") {
          return runEmbeddedAgent(params);
        }
        console.error("worktree readiness: failed-checkout embedded run entered");
        try {
          const result = await runEmbeddedAgent(params);
          console.error("worktree readiness: failed-checkout embedded run returned", {
            providerStarted: result.meta.providerStarted,
            aborted: result.meta.aborted,
            error: result.meta.error,
          });
          return result;
        } catch (error) {
          console.error(
            "worktree readiness: failed-checkout embedded run rejected",
            error instanceof Error ? error.message : typeof error,
          );
          throw error;
        }
      });
    // The spy calls this captured method with its original service instance below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const create = ManagedWorktreeService.prototype.createWithOutcome;
    const creationObserver = vi.spyOn(ManagedWorktreeService.prototype, "createWithOutcome");
    creationObserver.mockImplementation(function (this: ManagedWorktreeService, params) {
      const gate = activeGate;
      if (!gate || params.ownerId !== gate.key) {
        return create.call(this, params);
      }
      const onPromptReady = expectDefined(params.onPromptReady, "early prompt callback");
      const operation = create.call(this, {
        ...params,
        onPromptReady: async (facts) => {
          console.error("worktree readiness: publishing early prompt", gate.key);
          await onPromptReady(facts);
          console.error("worktree readiness: early prompt published", gate.key);
          gate.entered.resolve(facts);
          await gate.release.promise;
          if (gate.failure) {
            throw gate.failure;
          }
        },
      });
      void operation
        .then(
          () => gate.entered.reject(new Error("Checkout completed without an early prompt")),
          (error: unknown) => gate.entered.reject(error),
        )
        .finally(() => {
          console.error("worktree readiness: checkout settled", gate.key);
          gate.settled.resolve();
        });
      return operation;
    });
    const captureReadiness = workspaceReadiness.captureAgentWorkspaceReadiness;
    const readinessObserver = vi
      .spyOn(workspaceReadiness, "captureAgentWorkspaceReadiness")
      .mockImplementation((key) => {
        const captured = captureReadiness(key);
        const gate = activeGate;
        return captured && gate && gate.key === key
          ? {
              ...captured,
              waitUntilReady: () => {
                gate.toolWaiting.resolve();
                return captured.waitUntilReady();
              },
            }
          : captured;
      });
    const providerServer = productProvider(failures, (json, response, url) => {
      const body: unknown = JSON.parse(json);
      if (!isRecord(body)) {
        throw new Error("Synthetic provider received an invalid request");
      }
      if (url === "/capture") {
        deliveries.push(body);
        response.writeHead(200).end("captured");
        return;
      }
      const call = { body, response };
      providerCalls++;
      nextCall.resolve(call);
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await requireGit(repo, ["init", "-b", "main"]);
      await requireGit(repo, ["config", "user.name", "OpenClaw Test"]);
      await requireGit(repo, ["config", "user.email", "test@example.invalid"]);
      await fs.writeFile(path.join(repo, "AGENTS.md"), `${instruction}\n`);
      await fs.mkdir(path.join(repo, "src"));
      await fs.writeFile(path.join(repo, "src/remaining.txt"), fileContents);
      await requireGit(repo, ["add", "."]);
      await requireGit(repo, ["commit", "-qm", "synthetic project"]);
      const providerUrl = await listenProvider(providerServer);
      const provider = buildMockOpenAiResponsesProvider(providerUrl, "worktree-proof");
      const model = productModelConfig(repo, provider);
      const channelPath = await writeRecordingChannel(
        state.path("recording-channel"),
        new URL("/capture", providerUrl).href,
      );
      const cfg = {
        agents: {
          defaults: { ...model.defaults, utilityModel: "" },
        },
        models: model.models,
        plugins: {
          allow: ["readiness-chat"],
          load: { paths: [channelPath] },
          slots: { memory: "none" },
        },
        channels: { "readiness-chat": { enabled: true } },
        tools: {
          profile: "full",
          allow: ["read", "write", "message"],
          codeMode: false,
          toolSearch: false,
        },
        worktreeAcceleration: false,
        gateway: { auth: { mode: "token", token: "worktree-proof" } },
      } satisfies OpenClawConfig;
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: "worktree-proof",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => {
          const payload = event.payload;
          if (
            event.event !== "chat" ||
            !isRecord(payload) ||
            typeof payload.sessionKey !== "string" ||
            typeof payload.state !== "string"
          ) {
            return;
          }
          if (payload.sessionKey === "agent:main:readiness-early" && payload.state === "delta") {
            firstDelta.resolve();
          }
          if (
            payload.sessionKey === "agent:main:readiness-failure" &&
            ["final", "error", "aborted"].includes(payload.state)
          ) {
            console.error("worktree readiness: failure terminal observed", payload.state);
            terminalErrors.push(
              typeof payload.errorMessage === "string" ? payload.errorMessage : undefined,
            );
            failedTurn.resolve();
          }
        },
      });
      const client = gateway.client;
      const createWorktree = <T>(name: string, params: Record<string, unknown> = {}) =>
        client.request<T>("sessions.create", {
          key: `agent:main:${name}`,
          agentId: "main",
          displayName: name,
          worktree: true,
          worktreeName: name,
          worktreeBaseRef: "HEAD",
          ...params,
        });
      const expectRun = async (runId: string, status = "ok") =>
        expect(await client.request("agent.wait", { runId, timeoutMs: 60_000 })).toMatchObject({
          status,
        });
      const expectNoEffects = async (name: string, canary: string) => {
        expect(deliveries.filter((delivery) => delivery.to === name)).toEqual([]);
        await expect(fs.access(canary)).rejects.toMatchObject({ code: "ENOENT" });
      };
      const wait = <T>(work: PromiseLike<T>) => withinTest(work, signal);
      const startCheckout = async (
        name: string,
        message: string,
        failure?: Error,
        displayName = name,
      ) => {
        const gate: CheckoutGate = {
          key: `agent:main:${name}`,
          failure,
          entered: createDeferred<PromptFacts>(),
          release: createDeferred(),
          toolWaiting: createDeferred(),
          settled: createDeferred(),
        };
        activeGate = gate;
        nextCall = createDeferred<ProviderCall>();
        console.error("worktree readiness: creating session", gate.key);
        const started = await createWorktree<{
          key: string;
          runId: string;
          sessionId: string;
          runStarted: boolean;
        }>(name, { message, displayName });
        console.error("worktree readiness: session accepted", gate.key);
        const facts = await wait(gate.entered.promise);
        const call = await wait(nextCall.promise);
        console.error("worktree readiness: provider observed", gate.key);
        return { gate, started, facts, call };
      };
      const {
        gate: earlyGate,
        started: early,
        facts,
        call: initial,
      } = await startCheckout("readiness-early", userMessage, undefined, "Readiness proof");
      expect(early.runStarted).toBe(true);
      expect(JSON.stringify(initial.body)).toContain(instruction);
      await expect(fs.access(path.join(facts.path, "src/remaining.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      initial.response.writeHead(200, { "content-type": "text/event-stream" });
      writeEvent(initial.response, "output_item.added", {
        output_index: 0,
        item: { ...assistantMessage, content: [], status: "in_progress" },
      });
      writeTextEvent(initial.response, "delta", { delta: partial });
      await wait(firstDelta.promise);
      nextCall = createDeferred<ProviderCall>();
      finishWithTool(initial.response, "read", { path: "src/remaining.txt" });
      await wait(earlyGate.toolWaiting.promise);
      expect(providerCalls).toBe(1);
      await expect(fs.access(path.join(facts.path, "src/remaining.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      earlyGate.release.resolve();
      const result = await wait(nextCall.promise);
      expect(JSON.stringify(result.body.input)).toContain(fileContents.trim());
      finishText(result.response, fileContents, "done");
      await expectRun(early.runId);

      activeGate = undefined;
      const normal = await createWorktree<{
        key: string;
        worktree: { path: string; branch: string };
      }>("readiness-normal", { displayName: "Readiness proof" });
      nextCall = createDeferred<ProviderCall>();
      const normalRun = await gateway.client.request<{ runId: string }>("chat.send", {
        sessionKey: normal.key,
        message: userMessage,
        idempotencyKey: "readiness-normal-run",
      });
      const prepared = await wait(nextCall.promise);
      const initialPrefix = promptPrefix(initial.body, facts.path, facts.branch, early.key);
      const preparedPrefix = promptPrefix(
        prepared.body,
        normal.worktree.path,
        normal.worktree.branch,
        normal.key,
      );
      expect(initialPrefix).toBe(preparedPrefix);
      finishText(prepared.response, "Prepared prompt matches.", "normal");
      await expectRun(normalRun.runId);

      for (const toolName of ["write", "message"] as const) {
        for (const revoked of [false, true]) {
          const name = `readiness-${toolName}-${revoked ? "aborted" : "allowed"}`;
          const {
            gate,
            started,
            call: request,
          } = await startCheckout(
            name,
            toolName === "write"
              ? "Write a workspace canary."
              : "Send the workspace marker attachment.",
          );
          // Checkout rollback must not erase evidence of an unauthorized effect.
          const canary = state.path(`effects/${name}.txt`);
          nextCall = createDeferred<ProviderCall>();
          request.response.writeHead(200, { "content-type": "text/event-stream" });
          finishWithTool(
            request.response,
            toolName,
            toolName === "write"
              ? { path: canary, content: "workspace write canary" }
              : {
                  action: "send",
                  channel: "readiness-chat",
                  target: name,
                  message: name,
                  media: path.join(repo, "src/remaining.txt"),
                },
          );
          await wait(
            awaitGateBeforeSettlement(
              gate.toolWaiting.promise,
              nextCall.promise,
              `${name}: tool finished without waiting for checkout`,
            ),
          );
          await expectNoEffects(name, canary);
          const runEnded = waitForSessionRunEnd(started.sessionId, null);
          if (revoked) {
            expect(
              await gateway.client.request("chat.abort", {
                sessionKey: gate.key,
                runId: started.runId,
              }),
            ).toMatchObject({ aborted: true, runIds: [started.runId] });
          }
          gate.release.resolve();
          await wait(gate.settled.promise);
          if (!revoked) {
            const completedTool = await wait(nextCall.promise);
            if (toolName === "write") {
              expect(await fs.readFile(canary, "utf8")).toBe("workspace write canary");
            } else {
              expect(deliveries.filter((delivery) => delivery.to === name)).toEqual([
                { to: name, text: name, contents: fileContents },
              ]);
            }
            finishText(completedTool.response, "Effect completed.", name);
          }
          expect(await wait(runEnded)).toBe(true);
          await expectRun(started.runId, revoked ? "error" : "ok");
          if (revoked) {
            await expectNoEffects(name, canary);
          }
        }
      }

      const preparationError = new Error("Synthetic checkout failed; retry the session.");
      const { gate: failedGate, started: failed } = await startCheckout(
        "readiness-failure",
        userMessage,
        preparationError,
        "Readiness failure",
      );
      console.error("worktree readiness: releasing failed checkout", failedGate.key);
      failedGate.release.resolve();
      await wait(failedTurn.promise);
      await gateway.client.request("agent.wait", { runId: failed.runId, timeoutMs: 60_000 });
      expect(terminalErrors).toHaveLength(1);
      expect(JSON.stringify(terminalErrors)).toContain(preparationError.message);
      expect(failures).toEqual([]);
    } finally {
      activeGate?.release.resolve();
      await closeProvider(providerServer);
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "worktree readiness proof complete" });
        }
      } finally {
        modelObserver.mockRestore();
        creationObserver.mockRestore();
        readinessObserver.mockRestore();
        await state.cleanup();
      }
    }
  },
);
