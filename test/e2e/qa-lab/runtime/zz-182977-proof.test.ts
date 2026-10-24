import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { sendChat, waitForRun } from "./gateway-recovery.test-support.js";

const PLUGIN_ID = "agent-end-proof";
const SESSION_KEY = "agent:qa:182977-proof";

type ObservedMessage = { role?: string; content?: unknown };
type AgentEndObservation = { success?: boolean; messages?: ObservedMessage[] };
type ChatHistory = { messages?: ObservedMessage[] };

function textOf(message: ObservedMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(
      (block): block is { type?: string; text?: string } =>
        typeof block === "object" && block !== null,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

async function writeProofPlugin(dir: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "@openclaw/agent-end-proof",
      version: "1.0.0",
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await fs.writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, configSchema: { type: "object", properties: {} } }),
  );
  await fs.writeFile(
    path.join(dir, "index.cjs"),
    `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.on("agent_end", async (event) => {
      const target = process.env.OPENCLAW_QA_AGENT_END_PROOF;
      if (!target) throw new Error("missing OPENCLAW_QA_AGENT_END_PROOF");
      fs.appendFileSync(target, JSON.stringify({ success: event.success, messages: event.messages }) + "\\n");
    });
  },
};
`,
  );
}

it(
  "real Gateway keep one persisted request and deliver it to agent_end with steering",
  { timeout: 300_000 },
  async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-182977-proof-"));
    const pluginDir = path.join(tempRoot, "plugin");
    const proofPath = path.join(tempRoot, "agent-end.jsonl");
    await fs.mkdir(pluginDir);
    await writeProofPlugin(pluginDir);
    const owner = createQaGatewayChild();
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    try {
      await runQaGatewayFixture(
        async () => {
          mock = await startQaMockOpenAiServer({ modelRefs: ["openai/gpt-5.6-luna"] });
          const gateway = await owner.start({
            repoRoot: process.cwd(),
            forcedRuntime: "codex",
            providerMode: "mock-openai",
            providerBaseUrl: `${mock.baseUrl}/v1`,
            primaryModel: "openai/gpt-5.6-luna",
            alternateModel: "openai/gpt-5.6-luna",
            transportBaseUrl: "",
            controlUiEnabled: false,
            runtimeEnvPatch: { OPENCLAW_QA_AGENT_END_PROOF: proofPath },
            mutateConfig: (config) => {
              const plugins = (config.plugins ??= {});
              plugins.allow = [...(plugins.allow ?? []), PLUGIN_ID];
              plugins.load = {
                ...plugins.load,
                paths: [...(plugins.load?.paths ?? []), pluginDir],
              };
              plugins.entries = {
                ...plugins.entries,
                [PLUGIN_ID]: {
                  enabled: true,
                  hooks: { allowConversationAccess: true },
                },
              };
              return config;
            },
          });

          const first = (await sendChat(gateway, SESSION_KEY, "Remember alpha", {
            idempotencyKey: randomUUID(),
          })) as { runId: string; status: string };
          console.log("PROOF_FIRST", JSON.stringify(first));
          const steer = (await sendChat(gateway, SESSION_KEY, "Also beta", {
            idempotencyKey: randomUUID(),
            queueMode: "steer",
          })) as { runId?: string; status?: string };
          console.log("PROOF_STEER", JSON.stringify(steer));
          const completed = await waitForRun(gateway, first.runId, 120_000, 125_000);
          console.log("PROOF_TERMINAL", JSON.stringify(completed));

          for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
              if ((await fs.stat(proofPath)).size > 0) break;
            } catch {
              // wait for the hook process to append
            }
            await delay(100);
          }
          const observations = (await fs.readFile(proofPath, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as AgentEndObservation);
          const history = (await gateway.call("chat.history", {
            sessionKey: SESSION_KEY,
            limit: 50,
          })) as ChatHistory;
          const rows = (history.messages ?? []).map((message) => ({
            role: message.role,
            text: textOf(message),
          }));
          console.log("PROOF_HISTORY", JSON.stringify(rows));
          console.log("PROOF_AGENT_END", JSON.stringify(observations));

          const originalRows = rows.filter(
            (row) => row.role === "user" && row.text.includes("Remember alpha"),
          );
          expect(originalRows).toHaveLength(1);
          const steerRows = rows.filter(
            (row) => row.role === "user" && row.text.includes("Also beta"),
          );
          expect(steerRows).toHaveLength(1);
          const observation = observations.find((entry) =>
            (entry.messages ?? []).some(
              (message) => message.role === "user" && textOf(message).includes("Remember alpha"),
            ),
          );
          expect(observation, gateway.logs()).toBeDefined();
          const observedOriginal = (observation?.messages ?? []).filter(
            (message) => message.role === "user" && textOf(message).includes("Remember alpha"),
          );
          expect(observedOriginal).toHaveLength(1);
          const observedSteer = (observation?.messages ?? []).filter(
            (message) => message.role === "user" && textOf(message).includes("Also beta"),
          );
          expect(observedSteer).toHaveLength(1);
          expect(
            (observation?.messages ?? []).filter((message) => message.role === "assistant"),
          ).toHaveLength(1);
        },
        () => stopQaGatewayFixture(owner),
        () => mock?.stop(),
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);
