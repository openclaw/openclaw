#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const directory = process.argv[2];
const allowAlwaysOnly = process.argv.includes("--allow-always-only");
const workspaces = new Map();
const describe = () => ({
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "selected",
      options: [{ value: "selected", name: "Selected" }],
    },
  ],
});

// Match native agents that delegate an approved write back to their ACP client.
const connection = new AgentSideConnection(
  (client) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
        authMethods: [],
      };
    },
    async newSession({ cwd }) {
      const sessionId = randomUUID();
      workspaces.set(sessionId, cwd);
      return { sessionId, ...describe() };
    },
    async loadSession({ sessionId, cwd }) {
      workspaces.set(sessionId, cwd);
      return describe();
    },
    async prompt({ sessionId }) {
      const effectPath = path.join(workspaces.get(sessionId), "native-effect.txt");
      const toolCall = {
        toolCallId: "native-write",
        title: "Write the approved native effect",
        kind: "edit",
        status: "pending",
        rawInput: { path: effectPath, content: "approved native effect" },
      };
      await fs.writeFile(path.join(directory, "permission-request.json"), JSON.stringify(toolCall));
      const permission = await client.requestPermission({
        sessionId,
        toolCall,
        options: [
          {
            kind: allowAlwaysOnly ? "allow_always" : "allow_once",
            name: allowAlwaysOnly ? "Allow always" : "Allow once",
            optionId: "allow",
          },
          { kind: "reject_once", name: "Deny", optionId: "deny" },
        ],
      });
      await fs.writeFile(
        path.join(directory, "permission-result.json"),
        JSON.stringify(permission),
      );
      if (permission.outcome.outcome === "selected" && permission.outcome.optionId === "allow") {
        await client.writeTextFile({
          sessionId,
          path: effectPath,
          content: "approved native effect",
        });
      }
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Native permission request settled." },
        },
      });
      return { stopReason: "end_turn" };
    },
    async closeSession() {
      return {};
    },
    async cancel() {},
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
void connection;
