import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function createClaudeCliGatewayEnv() {
  return {
    PATH: undefined,
    OPENCLAW_PATH_BOOTSTRAPPED: "1",
    CLAUDE_CONFIG_DIR: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "dist/extensions"),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_GATEWAY_TOKEN: undefined,
    OPENCLAW_GATEWAY_PASSWORD: undefined,
  };
}

export function createClaudeCliGatewayConfig(
  workspaceDir: string,
  modelRef: string,
  token: string,
) {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        skipBootstrap: true,
        utilityModel: "",
        model: { primary: modelRef },
        models: { [modelRef]: { agentRuntime: { id: "claude-cli" } } },
      },
    },
    plugins: {
      enabled: true,
      allow: ["anthropic"],
      entries: {
        anthropic: { enabled: true, config: { sessionCatalog: { enabled: false } } },
      },
      slots: { memory: "none" },
    },
    tools: { profile: "minimal" },
    gateway: { auth: { mode: "token", token } },
  } satisfies OpenClawConfig;
}

// Synthetic Claude executable for the Gateway account-continuity scenarios.
export const createClaudeAuthFixture = (workspaceDir: string, projectDir: string) => String.raw`
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const nativeRoot = process.env.CLAUDE_CONFIG_DIR;
const nativeLogin = existsSync(join(nativeRoot, ".credentials.json"));
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.226 (Claude Code fixture)\n");
  process.exit(0);
}
if (process.argv.includes("auth")) {
  appendFileSync(join(nativeRoot, "auth-status.log"), "probe\n");
  send({ loggedIn: nativeLogin });
  process.exit(0);
}
const descriptor = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
let reply = "No managed credential supplied.";
if (nativeLogin) {
  reply = "Native account reply.";
}
if (descriptor !== undefined) {
  assert.equal(descriptor, "3");
  const token = readFileSync(3, "utf8");
  assert.ok(["synthetic-pasted-anthropic-token", "synthetic-replacement-anthropic-token"].includes(token));
  reply = token === "synthetic-replacement-anthropic-token"
    ? "Replacement account reply." : "Saved account reply.";
}
for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"]) {
  assert.equal(process.env[name], undefined);
}
let currentHistory;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { commands: [], models: [] },
    } });
  } else if (message.type === "user") {
    assert.equal(realpathSync.native(process.cwd()).normalize("NFC"), ${JSON.stringify(workspaceDir)});
    const resumeIndex = process.argv.indexOf("--resume");
    const sessionId = process.argv[(resumeIndex >= 0 ? resumeIndex : process.argv.indexOf("--session-id")) + 1];
    const projectDir = ${JSON.stringify(projectDir)};
    mkdirSync(projectDir, { recursive: true });
    const historyPath = join(projectDir, sessionId + ".jsonl");
    const resumedHistory = currentHistory ?? (resumeIndex >= 0
      ? readFileSync(historyPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
    appendFileSync(join(nativeRoot, "turns.jsonl"), JSON.stringify({
      sessionId, resume: resumeIndex >= 0, savedToken: descriptor !== undefined,
      resumedHistory,
    }) + "\n");
    const remembered = JSON.stringify(resumedHistory).match(/native-history-[a-f0-9-]+/);
    const turnReply = nativeLogin && descriptor === undefined && remembered
      ? "Native history: " + remembered[0] + "." : reply;
    const userUuid = message.uuid;
    const assistantUuid = randomUUID();
    const assistantMessage = {
      role: "assistant", content: [{ type: "text", text: turnReply }],
    };
    const rows = [
      { type: "user", uuid: userUuid, parentUuid: resumedHistory.at(-1)?.uuid ?? null,
        message: message.message },
      { type: "assistant", uuid: assistantUuid, parentUuid: userUuid, message: assistantMessage },
    ].map((row) => ({ ...row, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(), isSidechain: false }));
    currentHistory = [...resumedHistory, ...rows];
    writeFileSync(historyPath, currentHistory.map((row) => JSON.stringify(row)).join("\n") + "\n");
    send({ type: "assistant", uuid: assistantUuid, message: assistantMessage });
    send({ type: "result", subtype: "success", is_error: false,
      result: turnReply, session_id: sessionId });
  }
});
`;
