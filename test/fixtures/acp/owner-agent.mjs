#!/usr/bin/env node
// Synthetic ACP peer: persists its own conversation so restart tests must really load it.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const directory = process.argv[2];
const modelControls = process.argv.slice(3).includes("--model-controls");
const holdModeControl = process.argv.slice(3).includes("--hold-mode-control");
const holdNewSession = process.argv.slice(3).includes("--hold-new-session");
const holdPromptReply = process.argv.slice(3).includes("--hold-prompt-reply");
const promptGateUrl = process.argv
  .slice(3)
  .find((value) => value.startsWith("--prompt-gate-url="))
  ?.slice("--prompt-gate-url=".length);
const captureWorkerEnv = process.argv.slice(3).includes("--capture-worker-env");
const sessions = new Map();
const configOptions = (state) => [
  {
    id: "tone",
    name: "Tone",
    type: "select",
    currentValue: state.tone,
    options: [
      { value: "plain", name: "Plain" },
      { value: "brief", name: "Brief" },
    ],
  },
  ...(modelControls
    ? [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: state.currentModelId,
          options: [
            { value: "initial", name: "Initial" },
            { value: "selected", name: "Selected" },
          ],
        },
      ]
    : []),
];
const describe = (state) => ({
  modes: {
    currentModeId: state.mode,
    availableModes: [
      { id: "normal", name: "Normal" },
      { id: "review", name: "Review" },
    ],
  },
  configOptions: configOptions(state),
});
const file = (id) => path.join(directory, `${id}.json`);
const save = (id) => fs.writeFile(file(id), JSON.stringify(sessions.get(id)));
async function holdControl(name, value) {
  await fs.writeFile(path.join(directory, `${name}-entered`), value);
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      await fs.access(path.join(directory, `${name}-release`));
      return;
    } catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= deadline) {
        throw error;
      }
      await delay(5);
    }
  }
}
const connection = new AgentSideConnection(
  (client) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
        authMethods: [],
      };
    },
    async newSession({ cwd, mcpServers }) {
      const sessionId = randomUUID();
      const state = {
        history: [],
        tone: "plain",
        mode: "normal",
        cwd,
        mcpServers,
        argv: process.argv.slice(3),
        ...(captureWorkerEnv ? { workerThreads: process.env.TOKIO_WORKER_THREADS ?? null } : {}),
        ...(modelControls ? { currentModelId: "initial", modelChanges: [] } : {}),
      };
      sessions.set(sessionId, state);
      await save(sessionId);
      if (holdNewSession) {
        await holdControl("session-new", sessionId);
      }
      return { sessionId, ...describe(state) };
    },
    async loadSession({ sessionId, cwd, mcpServers }) {
      const state = JSON.parse(await fs.readFile(file(sessionId), "utf8"));
      state.loadedMcpServers = mcpServers;
      state.loadedCwd = cwd;
      sessions.set(sessionId, state);
      return describe(state);
    },
    async setSessionMode({ sessionId, modeId }) {
      if (holdModeControl && modeId === "review") {
        await holdControl("mode-control", modeId);
      }
      sessions.get(sessionId).mode = modeId;
      await save(sessionId);
      return {};
    },
    async setSessionConfigOption({ sessionId, configId, value }) {
      const state = sessions.get(sessionId);
      if (modelControls && configId === "model") {
        if (value !== "initial" && value !== "selected") {
          throw new Error("unknown model");
        }
        state.currentModelId = value;
        state.modelChanges.push(value);
      } else if (configId === "tone") {
        state.tone = value;
      } else {
        throw new Error("unknown option");
      }
      await save(sessionId);
      return { configOptions: configOptions(state) };
    },
    async prompt({ sessionId, prompt }) {
      const state = sessions.get(sessionId);
      state.history.push(
        prompt
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      );
      await save(sessionId);
      if (modelControls) {
        const effectsDirectory = path.join(directory, "effects");
        await fs.mkdir(effectsDirectory, { recursive: true });
        await fs.writeFile(
          path.join(effectsDirectory, `${sessionId}.txt`),
          state.history.join("\n"),
        );
      }
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: holdPromptReply ? "First chunk" : JSON.stringify({ sessionId, ...state }),
          },
        },
      });
      if (promptGateUrl) {
        await new Promise((resolve, reject) => {
          const request = http.get(promptGateUrl, { agent: false }, (response) => {
            response.resume();
            response.once("end", resolve);
            response.once("error", reject);
          });
          request.once("error", reject);
        });
      }
      if (holdPromptReply) {
        await holdControl("prompt-reply", sessionId);
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " second chunk" },
          },
        });
      }
      return { stopReason: "end_turn" };
    },
    async closeSession({ sessionId }) {
      sessions.delete(sessionId);
      await fs.rm(file(sessionId), { force: true });
      return {};
    },
    async cancel() {},
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
void connection;
