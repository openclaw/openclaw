import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
  type ProviderPrefixSnapshot,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shareCoreWithWorkshopPluginForTest } from "../skills/test-support/workshop-plugin.test-support.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
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
// Owns `other-skills`; plugin A has no way to name it.
const OTHER_PLUGIN_ID = "skill-authoring-other";
// Declares no agentSkillsDir, so it has no skills root to author.
const NOROOT_PLUGIN_ID = "skill-authoring-noroot";
const NOROOT_TOOL = "noroot_skill_write";
const SKILL_NAME = "proof-learned";
const REVOKED_SKILL = "proof-revoked";
const SKILL_DESCRIPTION = "PROOF_SKILL_DESCRIPTION use when proving plugin skill authoring";
const SKILL_MD = `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\nFollow the proof.\n`;

// A third-party-shaped plugin that writes only through the skill authoring SDK subpath; the
// host resolves its skills root from its own manifest, confines, scans, refreshes, dispatches.
function pluginSource(pluginId: string, tool: string, eventsFile: string, pauseFile: string) {
  return `import fs from "node:fs";
import {
  commitSkillChange,
  SkillAuthoringError,
  writeSkillFile,
} from "openclaw/plugin-sdk/skill-authoring-runtime";

export default {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.on("skill_changed", (event) => {
      fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({
        action: event.action,
        name: event.after?.name ?? event.before?.name,
        source: event.source,
        pluginId: event.pluginId,
        skillDir: event.after?.skillDir ?? event.before?.skillDir,
      }) + "\\n");
    });
    api.registerTool((ctx) => ({
      name: ${JSON.stringify(tool)},
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
        const commit = (apply) =>
          commitSkillChange({ config, agentId, skillName: params.name, apply });
        const write = () =>
          writeSkillFile({ config, agentId, skillName: params.name, filePath: "SKILL.md", content: params.content });
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
    }), { name: ${JSON.stringify(tool)} });
  },
};
`;
}

function writeToolCall(
  response: Parameters<typeof writeOpenAiResponsesText>[0],
  index: number,
  args: object,
  tool = TOOL,
) {
  const item = {
    type: "function_call",
    id: `fc_skill_authoring_${index}`,
    call_id: `call_skill_authoring_${index}`,
    name: tool,
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

/** Responses requests carry the system prompt as the first input message; compare it as system. */
function withLeadingSystemMessage(snapshot: ProviderPrefixSnapshot): ProviderPrefixSnapshot {
  const [first, ...rest] = snapshot.history;
  const message = first ? (JSON.parse(first) as { role?: unknown }) : undefined;
  if (message?.role !== "system" && message?.role !== "developer") {
    return snapshot;
  }
  expect(snapshot.system).toBe("null");
  return { ...snapshot, system: first ?? "null", history: rest };
}

const WORKSHOP_SKILL = "workshop-proof";
const WORKSHOP_DESCRIPTION = "WORKSHOP_SKILL_DESCRIPTION use when proving core Workshop authoring";

/**
 * The skill refresh contract a committed skill write follows, from the provider requests around
 * it: `sameTurn` compares the request right after the write's tool output with the one before;
 * `nextTurn` compares the next turn's first request with the write turn's last one.
 */
function skillRefreshShape(
  description: string,
  ...raw: [
    ProviderPrefixSnapshot,
    ProviderPrefixSnapshot,
    ProviderPrefixSnapshot,
    ProviderPrefixSnapshot,
  ]
) {
  const before = withLeadingSystemMessage(raw[0]);
  const sameTurn = withLeadingSystemMessage(raw[1]);
  const turnEnd = withLeadingSystemMessage(raw[2]);
  const nextTurn = withLeadingSystemMessage(raw[3]);
  // Within the write's turn the cacheable prefix stays byte-identical; history only appends.
  assertStableProviderPrefix(before, sameTurn, { label: "same turn after skill write" });
  // The next turn keeps tools, cache key and every earlier history item byte-identical...
  // The latest turn's runtime-context message is turn-scoped and never replayed (existing
  // contract), so the replayed prefix is the write turn's history without it.
  const replayed = turnEnd.history.filter(
    (item) => !item.includes('"text":"OpenClaw runtime context:'),
  );
  expect(turnEnd.history.length - replayed.length).toBe(1);
  assertStableProviderPrefix({ ...turnEnd, history: replayed, system: nextTurn.system }, nextTurn, {
    label: "next turn after skill write",
  });
  // ...and the system prompt changes only by the new skill's skills-list entry.
  const next = nextTurn.system;
  const at = next.indexOf(description);
  const entryStart = next.lastIndexOf("<skill>", at);
  const entryEnd = next.indexOf("</skill>", at) + "</skill>".length;
  // Entries are newline-indented; in JSON bytes the separator reads as an escaped newline.
  const separator = "\\n  ";
  const withoutEntry = [
    next.slice(0, entryStart) + next.slice(entryEnd + separator.length),
    next.slice(0, entryStart - separator.length) + next.slice(entryEnd),
  ];
  return {
    onlyEntryAdded: at > 0 && withoutEntry.includes(turnEnd.system),
    entry: next.slice(entryStart, entryEnd),
  };
}

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
    const eventsFile = path.join(tempHome, "skill-changed.jsonl");
    const pauseFile = path.join(tempHome, "revoke-pause.txt");
    const writePlugin = async (id: string, manifest: Record<string, unknown>, source: string) => {
      const dir = path.join(workspaceDir, ".openclaw", "extensions", id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          activation: { onStartup: true },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
          ...manifest,
        }),
      );
      await fs.writeFile(path.join(dir, "index.ts"), source);
    };
    await writePlugin(
      PLUGIN_ID,
      { agentSkillsDir: "proof-skills", contracts: { tools: [TOOL] } },
      pluginSource(PLUGIN_ID, TOOL, eventsFile, pauseFile),
    );
    await writePlugin(
      OTHER_PLUGIN_ID,
      { agentSkillsDir: "other-skills" },
      `export default { id: ${JSON.stringify(OTHER_PLUGIN_ID)}, register() {} };\n`,
    );
    // The bundled skill-workshop plugin owns skill_workshop and its `workshop-skills` folder;
    // this harness turns bundled plugins off, so enable a bundled root holding its source.
    deleteTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
    await shareCoreWithWorkshopPluginForTest();
    await writePlugin(
      NOROOT_PLUGIN_ID,
      { contracts: { tools: [NOROOT_TOOL] } },
      pluginSource(
        NOROOT_PLUGIN_ID,
        NOROOT_TOOL,
        path.join(tempHome, "noroot-events.jsonl"),
        pauseFile,
      ),
    );

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
      if (raw.includes("TURN_WORKSHOP_NEXT")) {
        writeOpenAiResponsesText(response, {
          text: "TURN_WORKSHOP_NEXT_DONE",
          messageId: "msg_skill_authoring_workshop_next",
          responseId: "resp_skill_authoring_workshop_next",
        });
        return;
      }
      if (raw.includes("TURN_WORKSHOP")) {
        if (!raw.includes("call_skill_authoring_5")) {
          writeToolCall(
            response,
            5,
            {
              action: "create",
              name: WORKSHOP_SKILL,
              content: `---\nname: ${WORKSHOP_SKILL}\ndescription: ${WORKSHOP_DESCRIPTION}\n---\n\nFollow the proof.\n`,
            },
            "skill_workshop",
          );
        } else {
          writeOpenAiResponsesText(response, {
            text: "TURN_WORKSHOP_DONE",
            messageId: "msg_skill_authoring_workshop",
            responseId: "resp_skill_authoring_workshop",
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
          name: "../other-skills/stolen",
          content: SKILL_MD.replace(SKILL_NAME, "stolen"),
        });
      } else if (outputs === 2) {
        writeToolCall(response, 4, { name: SKILL_NAME, content: SKILL_MD }, NOROOT_TOOL);
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
        plugins: { allow: [PLUGIN_ID, OTHER_PLUGIN_ID, NOROOT_PLUGIN_ID, "skill-workshop"] },
        tools: {
          profile: "full",
          alsoAllow: [TOOL, NOROOT_TOOL, "skill_workshop"],
          toolSearch: false,
        },
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

        await runTurn("Save the proof skill, then try the escapes.");
        expect(requests).toHaveLength(4);
        expect(requests[0]?.raw).not.toContain(SKILL_DESCRIPTION);
        const outputs = toolOutputs(requests[3]?.input ?? []).map((item) => JSON.stringify(item));
        expect(outputs[0]).toContain(`SKILL_WRITTEN ${SKILL_NAME}`);
        expect(outputs[1]).toContain("SKILL_REFUSED path_escape");
        expect(outputs[2]).toContain("SKILL_REFUSED no_skills_root");

        const agentDir = path.join(tempHome, ".openclaw", "agents", "main", "agent");
        const skillDir = path.join(agentDir, "proof-skills", SKILL_NAME);
        await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toBe(SKILL_MD);
        await expect(fs.stat(path.join(agentDir, "other-skills"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const events = (await fs.readFile(eventsFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events).toEqual([
          { action: "created", name: SKILL_NAME, source: "plugin", pluginId: PLUGIN_ID, skillDir },
        ]);

        await runTurn("TURN_TWO: which skills do you have?");
        expect(requests).toHaveLength(5);
        expect(requests[4]?.raw).toContain(SKILL_DESCRIPTION);

        // Prompt caching: a plugin commit follows core Workshop's skill refresh contract.
        await runTurn("TURN_WORKSHOP: save a Workshop skill.");
        await runTurn("TURN_WORKSHOP_NEXT: which skills do you have?");
        expect(requests).toHaveLength(8);
        const prefix = (index: number) =>
          snapshotProviderPrefix("openai-responses", JSON.parse(requests[index]?.raw ?? "{}"));
        const pluginShape = skillRefreshShape(
          SKILL_DESCRIPTION,
          prefix(0),
          prefix(1),
          prefix(3),
          prefix(4),
        );
        const workshopShape = skillRefreshShape(
          WORKSHOP_DESCRIPTION,
          prefix(5),
          prefix(6),
          prefix(6),
          prefix(7),
        );
        expect(JSON.stringify(toolOutputs(requests[6]?.input ?? []).at(-1))).toContain(
          `Created \\"${WORKSHOP_SKILL}\\"`,
        );
        for (const shape of [pluginShape, workshopShape]) {
          expect(shape.onlyEntryAdded).toBe(true);
        }
        expect(pluginShape.entry).toContain(SKILL_DESCRIPTION);
        expect(workshopShape.entry).toContain(WORKSHOP_DESCRIPTION);
        // Same section, same entry shape: only the skill's own facts differ.
        const entryShape = (entry: string, name: string, description: string, dir: string) =>
          entry
            .replaceAll(description, "<description>")
            .replaceAll(dir, "<dir>")
            .replaceAll(name, "<name>");
        expect(entryShape(pluginShape.entry, SKILL_NAME, SKILL_DESCRIPTION, "proof-skills")).toBe(
          entryShape(workshopShape.entry, WORKSHOP_SKILL, WORKSHOP_DESCRIPTION, "workshop-skills"),
        );

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
        // Workshop is a plugin author too (accepted cutover change); the revoked write added no
        // event.
        const allEvents = (await fs.readFile(eventsFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(allEvents.map(({ name, source, pluginId }) => ({ name, source, pluginId }))).toEqual(
          [
            { name: SKILL_NAME, source: "plugin", pluginId: PLUGIN_ID },
            { name: WORKSHOP_SKILL, source: "plugin", pluginId: "skill-workshop" },
          ],
        );
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
