import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { isRecord } from "../utils.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createGatewayConfigPath,
  nextGatewayId,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { startClaimedGateway } from "./test-helpers.listener.js";
import { createTrackedProvider } from "./test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

beforeEach(resetGatewayTestState);
afterEach(() => {
  vi.unstubAllEnvs();
  resetGatewayTestState();
});

const PLUGIN_ID = "skill-authoring-proof";
const TOOL = "proof_skill_write";
const SKILL_NAME = "proof-learned";
const REVOKED_SKILL = "proof-revoked";
const SKILL_DESCRIPTION = "PROOF_SKILL_DESCRIPTION use when proving plugin skill authoring";
const SKILL_MD = `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\nFollow the proof.\n`;

// A third-party-shaped plugin: it owns `proof-skills` through its manifest and writes only
// through the skill authoring SDK subpath; core confines, scans, refreshes and dispatches.
function pluginSource(eventsFile: string, pauseFile: string) {
  return `import fs from "node:fs";
import {
  commitSkillChange,
  resolveAgentSkillsRoot,
  SkillAuthoringError,
  writeSkillFile,
} from "openclaw/plugin-sdk/skill-authoring-runtime";

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.on("skill_changed", (event) => {
      fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({
        action: event.action,
        name: event.after?.name ?? event.before?.name,
        skillDir: event.after?.skillDir ?? event.before?.skillDir,
      }) + "\\n");
    });
    api.registerTool((ctx) => ({
      name: ${JSON.stringify(TOOL)},
      label: "Proof skill write",
      description: "Saves one learned skill.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          content: { type: "string" },
          waitForRevoke: { type: "boolean" },
        },
        required: ["name", "content"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        const config = ctx.getRuntimeConfig?.() ?? ctx.config ?? {};
        const agentId = ctx.agentId ?? "main";
        const skillsRoot = resolveAgentSkillsRoot({ config, agentId, dirName: "proof-skills" });
        const commit = (apply) =>
          commitSkillChange({ config, agentId, skillsRoot, skillName: params.name, source: "workshop", apply });
        const write = () =>
          writeSkillFile({ skillsRoot, skillName: params.name, filePath: "SKILL.md", content: params.content });
        if (params.waitForRevoke) {
          // Background work that outlives this plugin generation: it awaits until the plugin
          // is disabled, then tries to write.
          const pause = ${JSON.stringify(pauseFile)};
          api.lifecycle.runInBackgroundContext(() => {
            return commit(async () => {
              fs.writeFileSync(pause, "paused");
              const deadline = Date.now() + 20_000;
              while (!api.lifecycle.signal.aborted && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              fs.writeFileSync(pause, api.lifecycle.signal.aborted ? "aborted" : "timeout");
              return await write();
            }).then(
              () => fs.appendFileSync(pause, " committed"),
              (error) => fs.appendFileSync(pause, " refused " + (error && error.name)),
            );
          });
          return { content: [{ type: "text", text: "SKILL_WRITE_STARTED " + params.name }] };
        }
        try {
          await commit(write);
          return { content: [{ type: "text", text: "SKILL_WRITTEN " + params.name }] };
        } catch (error) {
          if (error instanceof SkillAuthoringError) {
            return { content: [{ type: "text", text: "SKILL_REFUSED " + error.code }] };
          }
          throw error;
        }
      },
    }), { name: ${JSON.stringify(TOOL)} });
  },
};
`;
}

function writeToolCall(
  response: Parameters<typeof writeOpenAiResponsesText>[0],
  index: number,
  args: object,
) {
  const item = {
    type: "function_call",
    id: `fc_skill_authoring_${index}`,
    call_id: `call_skill_authoring_${index}`,
    name: TOOL,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_skill_authoring_call_${index}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

const toolOutputs = (input: unknown[]) =>
  input.filter((item) => isRecord(item) && item.type === "function_call_output");

it(
  "lets a loaded plugin author a skill that the next turn discovers, refusing an escape and a revoked write",
  { timeout: 120_000 },
  async () => {
    const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
      prefix: "openclaw-gw-skill-authoring-",
    });
    // The subpath is private to bundled plugins; the private-QA switch admits this fixture.
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
    const token = nextGatewayId("skill-authoring-token");
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", PLUGIN_ID);
    const eventsFile = path.join(tempHome, "skill-changed.jsonl");
    const pauseFile = path.join(tempHome, "revoke-pause.txt");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: PLUGIN_ID,
        activation: { onStartup: true },
        agentSkillsDir: "proof-skills",
        contracts: { tools: [TOOL] },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    await fs.writeFile(path.join(pluginDir, "index.ts"), pluginSource(eventsFile, pauseFile));

    const requests: Array<{ raw: string; input: unknown[] }> = [];
    const provider = createTrackedProvider((raw, response, request) => {
      if (request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const input = (JSON.parse(raw) as { input?: unknown[] }).input ?? [];
      requests.push({ raw, input });
      if (raw.includes("TURN_THREE")) {
        if (!raw.includes("call_skill_authoring_3")) {
          writeToolCall(response, 3, {
            name: REVOKED_SKILL,
            content: SKILL_MD.replaceAll(SKILL_NAME, REVOKED_SKILL),
            waitForRevoke: true,
          });
        } else {
          writeOpenAiResponsesText(response, {
            text: "TURN_THREE_DONE",
            messageId: "msg_skill_authoring_three",
            responseId: "resp_skill_authoring_three",
          });
        }
        return;
      }
      if (raw.includes("TURN_TWO")) {
        writeOpenAiResponsesText(response, {
          text: "TURN_TWO_DONE",
          messageId: "msg_skill_authoring_two",
          responseId: "resp_skill_authoring_two",
        });
        return;
      }
      const outputs = toolOutputs(input).length;
      if (outputs === 0) {
        writeToolCall(response, 1, { name: SKILL_NAME, content: SKILL_MD });
      } else if (outputs === 1) {
        writeToolCall(response, 2, {
          name: "../escape",
          content: SKILL_MD.replace(SKILL_NAME, "escape"),
        });
      } else {
        writeOpenAiResponsesText(response, {
          text: "TURN_ONE_DONE",
          messageId: "msg_skill_authoring_one",
          responseId: "resp_skill_authoring_one",
        });
      }
    });
    const openaiBaseUrl = await provider.listen();

    try {
      const configPath = await createGatewayConfigPath(tempHome);
      const mockProvider = buildMockOpenAiResponsesProvider(openaiBaseUrl);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            model: { primary: mockProvider.modelRef },
            models: {
              [mockProvider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
            },
            skipBootstrap: true,
          },
          entries: { main: {} },
        },
        plugins: { allow: [PLUGIN_ID] },
        tools: { profile: "full", alsoAllow: [TOOL], toolSearch: false },
        models: { mode: "replace", providers: { [mockProvider.providerId]: mockProvider.config } },
        gateway: { auth: { mode: "token", token } },
      };
      await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n");
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const { port } = portClaim;
      const server = await startClaimedGateway(portClaim, () =>
        startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        }),
      );
      const client = await connectGatewayClient({
        url: "ws://127.0.0.1:" + port,
        token,
        clientName: GATEWAY_CLIENT_NAMES.TUI,
        clientDisplayName: "skill-authoring-proof",
        mode: GATEWAY_CLIENT_MODES.UI,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        const sessionKey = "agent:main:skill-authoring";
        const startTurn = async (message: string) => {
          const started = await client.request<{ runId?: string; status?: string }>(
            "chat.send",
            {
              sessionKey,
              idempotencyKey: nextGatewayId("skill-authoring-run"),
              message,
              deliver: false,
              originatingChannel: "tui",
              originatingTo: "skill-authoring-proof",
            },
            { expectFinal: false },
          );
          expect(started.status).toBe("started");
          return started.runId;
        };
        const runTurn = async (message: string) => {
          const runId = await startTurn(message);
          const completed = await client.request<{ status?: string }>(
            "agent.wait",
            { runId, timeoutMs: 45_000 },
            { timeoutMs: 50_000 },
          );
          expect(completed.status).toBe("ok");
        };

        await runTurn("Save the proof skill, then try the escape.");
        expect(requests).toHaveLength(3);
        expect(requests[0]?.raw).not.toContain(SKILL_DESCRIPTION);
        const outputs = toolOutputs(requests[2]?.input ?? []).map((item) => JSON.stringify(item));
        expect(outputs[0]).toContain(`SKILL_WRITTEN ${SKILL_NAME}`);
        expect(outputs[1]).toContain("SKILL_REFUSED path_escape");

        const agentDir = path.join(tempHome, ".openclaw", "agents", "main", "agent");
        const skillDir = path.join(agentDir, "proof-skills", SKILL_NAME);
        await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toBe(SKILL_MD);
        await expect(fs.stat(path.join(agentDir, "escape"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const events = (await fs.readFile(eventsFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events).toEqual([{ action: "created", name: SKILL_NAME, skillDir }]);

        await runTurn("TURN_TWO: which skills do you have?");
        expect(requests).toHaveLength(4);
        expect(requests[3]?.raw).toContain(SKILL_DESCRIPTION);

        // Disable the plugin while its background write awaits. Disposal revokes the plugin
        // generation, so the late write commits nothing and no skill_changed fires.
        await runTurn("TURN_THREE: save another skill.");
        await vi.waitFor(() => expect(readFileSync(pauseFile, "utf8")).toBe("paused"), {
          timeout: 30_000,
          interval: 25,
        });
        await client.request(
          "plugins.setEnabled",
          { pluginId: PLUGIN_ID, enabled: false },
          { timeoutMs: 60_000 },
        );
        await vi.waitFor(
          () => expect(readFileSync(pauseFile, "utf8")).toMatch(/ (refused|committed)/),
          {
            timeout: 30_000,
            interval: 25,
          },
        );
        expect(readFileSync(pauseFile, "utf8")).toBe(
          "aborted refused PluginInstanceUnavailableError",
        );
        await expect(
          fs.stat(path.join(agentDir, "proof-skills", REVOKED_SKILL)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.readFile(eventsFile, "utf8")).trim().split("\n")).toHaveLength(1);
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "skill authoring proof complete" });
      }
    } finally {
      try {
        await provider.close();
      } finally {
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    }
  },
);
