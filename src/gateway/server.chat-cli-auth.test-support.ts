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
