import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../test/helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { createDefaultDeps } from "../../cli/deps.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { withLocalGatewayRequestScope } from "../../gateway/local-request-context.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { createRuntimeAgent } from "./runtime-agent.js";

const sessionKey = "agent:main:discord:channel:ingress-proof";
const label = "Voice owner admitted";
const fileName = "voice-ingress.txt";
const fileContent = "Voice tool execution reached the workspace.";

function writeToolCalls(response: ServerResponse): void {
  const calls = [
    { name: "sessions", arguments: { action: "patch", label } },
    { name: "write", arguments: { path: fileName, content: fileContent } },
  ].map((call, index) => ({
    type: "function_call",
    id: `fc_voice_${index}`,
    call_id: `call_voice_${index}`,
    name: call.name,
    arguments: JSON.stringify(call.arguments),
  }));
  writeOpenAiResponsesSse(response, [
    {
      type: "response.created",
      response: { id: "response_voice_tools", status: "in_progress", output: [] },
    },
    ...calls.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item: { ...item, arguments: "" } },
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index,
        delta: item.arguments,
      },
      { type: "response.output_item.done", output_index, item },
    ]),
    {
      type: "response.completed",
      response: {
        id: "response_voice_tools",
        status: "completed",
        output: calls,
        usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 },
      },
    },
  ]);
}

async function withIngressFixture(options: {
  senderIsOwner: boolean;
  toolsAllow: string[];
  cancel?: boolean;
}) {
  return withOpenClawTestState(
    {
      label: "runtime-agent-ingress",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_SKIP_PROVIDERS: undefined },
    },
    async (state) => {
      const received = createDeferred<ServerResponse>();
      void received.promise.catch(() => {});
      const cancelled = createDeferred();
      const controller = new AbortController();
      let toolResults = "";
      let turn: Promise<unknown> | undefined;
      const server = await startOpenAiResponsesModelServer({
        modelId: "voice-ingress",
        bindError: "Voice ingress provider did not bind a loopback port",
        onRequest: async (request, response) => {
          try {
            const body = await text(request);
            if (body.includes("function_call_output")) {
              toolResults = body;
              writeOpenAiResponsesText(response, {
                text: "Voice turn finished.",
                responseId: "response_voice_done",
                messageId: "message_voice_done",
              });
              return;
            }
            if (options.cancel) {
              response.once("close", () => {
                if (!response.writableFinished) {
                  cancelled.resolve();
                }
              });
              received.resolve(response);
              return;
            }
            writeToolCalls(response);
          } catch (error) {
            received.reject(error);
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      try {
        const cfg = createOpenAiResponsesModelConfig({
          baseUrl: server.baseUrl,
          providerId: "mock-openai",
          modelId: "voice-ingress",
          reasoning: false,
          toolProfile: "coding",
        });
        cfg.plugins = { enabled: false };
        cfg.agents = { ...cfg.agents, entries: { main: { workspace: state.workspaceDir } } };
        cfg.tools = {
          allow: ["sessions", "write", "read"],
          codeMode: { enabled: false },
          // The synthetic provider emits direct tool calls instead of catalog lookups.
          toolSearch: false,
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg, cfg);
        const { log, error: logError, exit } = createRuntimeEnv();
        turn = withLocalGatewayRequestScope(
          { deps: createDefaultDeps(), getRuntimeConfig: () => cfg },
          () =>
            createRuntimeAgent().runCommandFromIngress(
              {
                agentId: "main",
                sessionKey,
                message: "Update this session label and write the requested workspace file.",
                messageChannel: "discord",
                senderIsOwner: options.senderIsOwner,
                toolsAllow: options.toolsAllow,
                abortSignal: controller.signal,
                allowModelOverride: false,
                deliver: false,
                timeout: "30",
              },
              { log, error: logError, exit },
            ),
        );
        if (options.cancel) {
          const response = await Promise.race([
            received.promise,
            turn.then(() => {
              throw new Error("Agent completed before the provider received the turn");
            }),
          ]);
          controller.abort(new Error("Voice participant left the room"));
          await withTestTimeout(
            Promise.all([Promise.allSettled([turn]), cancelled.promise]),
            5_000,
            "Ingress did not cancel the agent and provider request",
          );
          // Late provider output must never revive the cancelled run's tool authority.
          writeToolCalls(response);
        } else {
          await turn;
          expect(toolResults).toContain("function_call_output");
        }
        const file = await fs
          .readFile(path.join(state.workspaceDir, fileName), "utf8")
          .catch((error: unknown) => {
            if (!hasErrnoCode(error, "ENOENT")) {
              throw error;
            }
            return undefined;
          });
        return {
          storedLabel: loadSessionEntry({ agentId: "main", sessionKey })?.label,
          file,
          toolResults,
        };
      } finally {
        controller.abort();
        await server.close();
        await Promise.allSettled(turn ? [turn] : []);
      }
    },
  );
}

describe("host runtime ingress agent effects", () => {
  it.each([
    { name: "owner", senderIsOwner: true, toolsAllow: ["sessions", "write"], canPatch: true },
    { name: "guest", senderIsOwner: false, toolsAllow: ["sessions", "write"], canPatch: false },
    { name: "restricted owner", senderIsOwner: true, toolsAllow: ["write"], canPatch: false },
  ])("enforces $name authority in the real tool loop", { timeout: 90_000 }, async (scenario) => {
    expect(await withIngressFixture(scenario)).toMatchObject({
      storedLabel: scenario.canPatch ? label : undefined,
      file: fileContent,
    });
  });

  it("cancels tool I/O and discards late provider calls", { timeout: 90_000 }, async () => {
    expect(
      await withIngressFixture({
        senderIsOwner: true,
        toolsAllow: ["sessions", "write"],
        cancel: true,
      }),
    ).toEqual({ storedLabel: undefined, file: undefined, toolResults: "" });
  });
});
