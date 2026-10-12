import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as workspaceReadiness from "../agents/workspace-readiness.js";
import { requireGit } from "../agents/worktrees/git.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import type { CreateManagedWorktreeParams } from "../agents/worktrees/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { areHeartbeatsEnabled, setHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import type { Deferred } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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

function finishWithRead(response: ServerResponse) {
  const message = {
    type: "message",
    id: "msg_readiness",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: partial, annotations: [] }],
  };
  const item = {
    type: "function_call",
    id: "fc_read_remaining",
    call_id: "call_read_remaining",
    name: "read",
    arguments: JSON.stringify({ path: "src/remaining.txt" }),
    status: "completed",
  };
  for (const event of [
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text: partial,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 1,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 1, item },
    {
      type: "response.completed",
      response: {
        id: "resp_read_remaining",
        status: "completed",
        output: [message, item],
        usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
      },
    },
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
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
  "starts inference before checkout, gates workspace reads, and preserves the prepared prompt",
  { timeout: 90_000 },
  async ({ signal }) => {
    const state = await createOpenClawTestState({
      label: "chat-worktree-readiness",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    const repo = state.workspaceDir;
    const calls: ProviderCall[] = [];
    const failures: unknown[] = [];
    const terminals: Array<{ sessionKey?: string; state?: string; errorMessage?: string }> = [];
    let nextCall = createDeferred<ProviderCall>();
    let activeGate: CheckoutGate | undefined;
    const firstDelta = createDeferred();
    const failedTurn = createDeferred();
    let checkpoint = "gateway startup";
    const makeGate = (key: string, failure?: Error): CheckoutGate => ({
      key,
      failure,
      entered: createDeferred<PromptFacts>(),
      release: createDeferred(),
      toolWaiting: createDeferred(),
      settled: createDeferred(),
    });
    // The spy calls this captured method with its original service instance below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const create = ManagedWorktreeService.prototype.createWithOutcome;
    const creationObserver = vi.spyOn(ManagedWorktreeService.prototype, "createWithOutcome");
    creationObserver.mockImplementation(function (this: ManagedWorktreeService, params) {
      const gate = activeGate;
      const onPromptReady = params.onPromptReady;
      if (!gate || params.ownerId !== gate.key) {
        return create.call(this, params);
      }
      const operation = create.call(
        this,
        onPromptReady
          ? {
              ...params,
              onPromptReady: async (facts) => {
                await onPromptReady(facts);
                gate.entered.resolve(facts);
                await gate.release.promise;
                if (gate.failure) {
                  throw gate.failure;
                }
              },
            }
          : params,
      );
      void operation.then(
        () => {
          gate.entered.reject(
            new Error(
              `Checkout did not publish early prompt (callback=${Boolean(onPromptReady)}, sourceOnly=${params.provisionIgnoredFiles === false})`,
            ),
          );
          gate.settled.resolve();
        },
        (error: unknown) => {
          gate.entered.reject(error);
          gate.settled.resolve();
        },
      );
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
    const providerServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!isRecord(body)) {
          throw new Error("Synthetic provider received an invalid request");
        }
        const call = { body, response };
        calls.push(call);
        nextCall.resolve(call);
      })().catch((error: unknown) => {
        failures.push(error);
        response.writeHead(500).end("Synthetic provider failed");
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    const heartbeats = areHeartbeatsEnabled();
    try {
      setHeartbeatsEnabled(false);
      await requireGit(repo, ["init", "-b", "main"]);
      await requireGit(repo, ["config", "user.name", "OpenClaw Test"]);
      await requireGit(repo, ["config", "user.email", "test@example.invalid"]);
      await fs.writeFile(path.join(repo, "AGENTS.md"), `${instruction}\n`);
      await fs.mkdir(path.join(repo, "src"));
      await fs.writeFile(path.join(repo, "src/remaining.txt"), fileContents);
      await requireGit(repo, ["add", "."]);
      await requireGit(repo, ["commit", "-qm", "synthetic project"]);
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Synthetic provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "worktree-proof",
      );
      const cfg = {
        agents: {
          defaults: {
            workspace: repo,
            skipBootstrap: true,
            utilityModel: "",
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
          },
        },
        plugins: { slots: { memory: "none" } },
        tools: { profile: "coding", allow: ["read"], codeMode: false, toolSearch: false },
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
          if (["final", "error", "aborted"].includes(payload.state ?? "")) {
            terminals.push({
              sessionKey: payload.sessionKey,
              state: payload.state,
              ...(typeof payload.errorMessage === "string"
                ? { errorMessage: payload.errorMessage }
                : {}),
            });
            if (payload.sessionKey === "agent:main:readiness-failure") {
              failedTurn.resolve();
            }
          }
        },
      });
      activeGate = makeGate("agent:main:readiness-early");
      const early = await gateway.client.request<{
        key: string;
        runId: string;
        runStarted: boolean;
      }>("sessions.create", {
        key: activeGate.key,
        agentId: "main",
        displayName: "Readiness proof",
        worktree: true,
        worktreeName: "readiness-early",
        worktreeBaseRef: "HEAD",
        message: userMessage,
      });
      expect(early.runStarted).toBe(true);
      checkpoint = "early prompt preparation";
      const facts = await withinTest(
        awaitGateBeforeSettlement(
          activeGate.entered.promise,
          activeGate.settled.promise,
          "Checkout completed without publishing an early prompt",
        ),
        signal,
      );
      checkpoint = "first model request";
      const initial = await withinTest(nextCall.promise, signal);
      expect(JSON.stringify(initial.body)).toContain(instruction);
      await expect(fs.access(path.join(facts.path, "src/remaining.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      initial.response.writeHead(200, { "content-type": "text/event-stream" });
      initial.response.write(
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_readiness",
            role: "assistant",
            content: [],
            status: "in_progress",
          },
        })}\n\n`,
      );
      initial.response.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: "msg_readiness",
          output_index: 0,
          content_index: 0,
          delta: partial,
        })}\n\n`,
      );
      checkpoint = "first text delta";
      await withinTest(firstDelta.promise, signal);
      nextCall = createDeferred<ProviderCall>();
      finishWithRead(initial.response);
      checkpoint = "workspace tool readiness wait";
      await withinTest(activeGate.toolWaiting.promise, signal);
      expect(calls).toHaveLength(1);
      await expect(fs.access(path.join(facts.path, "src/remaining.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      activeGate.release.resolve();
      checkpoint = "workspace tool result";
      const result = await withinTest(nextCall.promise, signal);
      expect(JSON.stringify(result.body.input)).toContain(fileContents.trim());
      writeOpenAiResponsesText(result.response, {
        text: fileContents,
        messageId: "msg_done",
        responseId: "resp_done",
      });
      expect(
        await gateway.client.request("agent.wait", { runId: early.runId, timeoutMs: 60_000 }),
      ).toMatchObject({ status: "ok" });

      activeGate = undefined;
      checkpoint = "prepared-workspace comparison";
      const normal = await gateway.client.request<{
        key: string;
        worktree: { path: string; branch: string };
      }>("sessions.create", {
        key: "agent:main:readiness-normal",
        agentId: "main",
        displayName: "Readiness proof",
        worktree: true,
        worktreeName: "readiness-normal",
        worktreeBaseRef: "HEAD",
      });
      nextCall = createDeferred<ProviderCall>();
      const normalRun = await gateway.client.request<{ runId: string }>("chat.send", {
        sessionKey: normal.key,
        message: userMessage,
        idempotencyKey: "readiness-normal-run",
      });
      const prepared = await withinTest(nextCall.promise, signal);
      const initialPrefix = promptPrefix(initial.body, facts.path, facts.branch, early.key);
      const preparedPrefix = promptPrefix(
        prepared.body,
        normal.worktree.path,
        normal.worktree.branch,
        normal.key,
      );
      const mismatch = initialPrefix
        .split("")
        .findIndex((character, index) => character !== preparedPrefix[index]);
      expect(
        initialPrefix === preparedPrefix,
        `Prompt differs at ${mismatch}: ${JSON.stringify({
          initial: initialPrefix.slice(Math.max(0, mismatch - 60), mismatch + 140),
          prepared: preparedPrefix.slice(Math.max(0, mismatch - 60), mismatch + 140),
        })}`,
      ).toBe(true);
      writeOpenAiResponsesText(prepared.response, {
        text: "Prepared prompt matches.",
        messageId: "msg_normal",
        responseId: "resp_normal",
      });
      expect(
        await gateway.client.request("agent.wait", { runId: normalRun.runId, timeoutMs: 60_000 }),
      ).toMatchObject({ status: "ok" });

      const preparationError = new Error("Synthetic checkout failed; retry the session.");
      checkpoint = "preparation failure";
      const failedGate = makeGate("agent:main:readiness-failure", preparationError);
      activeGate = failedGate;
      nextCall = createDeferred<ProviderCall>();
      const failed = await gateway.client.request<{ runId: string }>("sessions.create", {
        key: activeGate.key,
        agentId: "main",
        displayName: "Readiness failure",
        worktree: true,
        worktreeName: "readiness-failure",
        worktreeBaseRef: "HEAD",
        message: userMessage,
      });
      await withinTest(activeGate.entered.promise, signal);
      await withinTest(nextCall.promise, signal);
      activeGate.release.resolve();
      await withinTest(failedTurn.promise, signal);
      await gateway.client.request("agent.wait", { runId: failed.runId, timeoutMs: 60_000 });
      const errors = terminals.filter((event) => event.sessionKey === failedGate.key);
      expect(errors).toHaveLength(1);
      expect(JSON.stringify(errors)).toContain(preparationError.message);
      expect(failures).toEqual([]);
    } finally {
      if (signal.aborted) {
        console.error(`Worktree proof stopped at: ${checkpoint}`);
      }
      activeGate?.release.resolve();
      providerServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        providerServer.close(() => resolve());
      });
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "worktree readiness proof complete" });
        }
      } finally {
        creationObserver.mockRestore();
        readinessObserver.mockRestore();
        setHeartbeatsEnabled(heartbeats);
        await state.cleanup();
      }
    }
  },
);
