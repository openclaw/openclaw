import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWindowsCmdShimFixture } from "../test-helpers/windows-cmd-shim.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

// Only the external executable is a fixture. The registered Gateway, Anthropic
// plugin, profile selection, credential transport, and transcript writer are real.
const CLAUDE_AUTH_FIXTURE = String.raw`
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
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
    const resumeIndex = process.argv.indexOf("--resume");
    const sessionId = process.argv[(resumeIndex >= 0 ? resumeIndex : process.argv.indexOf("--session-id")) + 1];
    const projectDir = join(nativeRoot, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
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

const cases: {
  name: string;
  order: NonNullable<OpenClawConfig["auth"]>["order"];
  credential?: AuthProfileCredential;
  nativeContinuity?: boolean;
  reply: string;
}[] = [
  {
    name: "keeps native account history when a saved token appears and uses it for a new session",
    order: undefined,
    nativeContinuity: true,
    reply: "Native account reply.",
  },
  {
    name: "uses a saved canonical paste-token without an explicit account selection or native login",
    order: undefined,
    credential: { type: "token", provider: "anthropic", token: "synthetic-pasted-anthropic-token" },
    reply: "Saved account reply.",
  },
  {
    name: "uses a saved canonical paste-token selected by the canonical account order",
    order: { anthropic: ["anthropic:pasted"] },
    credential: { type: "token", provider: "anthropic", token: "synthetic-pasted-anthropic-token" },
    reply: "Saved account reply.",
  },
  {
    name: "honors an explicit empty CLI account order despite a saved canonical paste-token",
    order: { "claude-cli": [] },
    credential: { type: "token", provider: "anthropic", token: "synthetic-pasted-anthropic-token" },
    reply: "No managed credential supplied.",
  },
  {
    name: "leaves native authentication in charge when only a canonical API key is saved",
    order: undefined,
    credential: { type: "api_key", provider: "anthropic", key: "synthetic-pasted-anthropic-key" },
    reply: "No managed credential supplied.",
  },
];

it.each(cases)(
  "chat.send $name",
  { timeout: 90_000 },
  async ({ order, credential, reply, nativeContinuity }) => {
    // Each case changes startup auth configuration and owns an empty native-login root.
    const state = await createOpenClawTestState({
      label: "chat-cli-auth",
      env: {
        PATH: process.env.PATH,
        CLAUDE_CONFIG_DIR: undefined,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_OAUTH_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
        CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const binDir = state.path("bin");
      const scriptPath = path.join(binDir, "claude.cjs");
      await fs.mkdir(binDir);
      if (process.platform === "win32") {
        await createWindowsCmdShimFixture({
          shimPath: path.join(binDir, "claude.cmd"),
          scriptPath,
          shimLine: `"${process.execPath}" "%~dp0\\claude.cjs" %*`,
        });
      } else {
        await fs.writeFile(
          path.join(binDir, "claude"),
          `#!${process.execPath}\n${CLAUDE_AUTH_FIXTURE}`,
          {
            mode: 0o755,
          },
        );
      }
      await fs.writeFile(scriptPath, CLAUDE_AUTH_FIXTURE);
      setTestEnvValue("PATH", [binDir, process.env.PATH].filter(Boolean).join(path.delimiter));
      const nativeRoot = path.join(state.home, ".claude");
      setTestEnvValue("CLAUDE_CONFIG_DIR", nativeRoot);
      await fs.mkdir(nativeRoot);
      if (nativeContinuity) {
        await fs.writeFile(
          path.join(nativeRoot, ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "synthetic-native-login-token",
              refreshToken: "synthetic-native-refresh-token",
              expiresAt: Date.now() + 3_600_000,
              scopes: ["user:inference", "user:profile"],
              subscriptionType: "max",
            },
          }),
        );
      }
      await state.writeAuthProfiles({
        version: 1,
        profiles: credential ? { "anthropic:pasted": credential } : {},
      });
      const modelRef = "anthropic/claude-sonnet-4-6";
      const token = "chat-cli-auth-test";
      const cfg = {
        ...(order ? { auth: { order } } : {}),
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: modelRef },
            models: { [modelRef]: { agentRuntime: { id: "claude-cli" } } },
          },
        },
        plugins: {
          enabled: true,
          allow: ["anthropic"],
          entries: { anthropic: { enabled: true, config: { sessionCatalog: { enabled: false } } } },
          slots: { memory: "none" },
        },
        tools: { profile: "minimal" },
        gateway: { auth: { mode: "token", token } },
      } satisfies OpenClawConfig;
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      await gateway.server.startupSettled;
      const sessionKey = `agent:main:cli-auth-${randomUUID()}`;
      const sendTurn = async (
        client: NonNullable<typeof gateway>["client"],
        turnSessionKey: string,
        message: string,
        expectedReply: string,
      ) => {
        const accepted = await client.request<{ runId: string; status: string }>("chat.send", {
          sessionKey: turnSessionKey,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(accepted.status).toBe("started");
        const completed = await client.request<{ status: string }>(
          "agent.wait",
          { runId: accepted.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        expect(completed.status).toBe("ok");
        const history = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: turnSessionKey,
        });
        expect(history.messages).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([{ type: "text", text: expectedReply }]),
          }),
        );
      };
      const marker = `native-history-${randomUUID()}`;
      await sendTurn(
        gateway.client,
        sessionKey,
        nativeContinuity ? `Remember ${marker}.` : "Reply using the saved account.",
        reply,
      );
      if (nativeContinuity) {
        const original =
          loadGatewaySessionEntryReadOnly(sessionKey).entry?.cliSessionBindings?.["claude-cli"];
        expect(original?.sessionId).toBeTruthy();
        expect(original?.authProfileId).toBeUndefined();
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "anthropic:pasted": {
              type: "token",
              provider: "anthropic",
              token: "synthetic-pasted-anthropic-token",
            },
          },
        });
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "Verify persisted native account continuity" });
        gateway = await startGatewayWithClient({
          cfg,
          configPath: state.configPath,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        await gateway.server.startupSettled;
        await sendTurn(
          gateway.client,
          sessionKey,
          "Recall the marker from our previous turn.",
          `Native history: ${marker}.`,
        );
        const resumed =
          loadGatewaySessionEntryReadOnly(sessionKey).entry?.cliSessionBindings?.["claude-cli"];
        expect(resumed?.sessionId).toBe(original?.sessionId);
        expect(resumed?.authProfileId).toBe(original?.authProfileId);
        const savedSessionKey = `agent:main:cli-auth-${randomUUID()}`;
        await sendTurn(
          gateway.client,
          savedSessionKey,
          "Reply using the saved account.",
          "Saved account reply.",
        );
        const saved =
          loadGatewaySessionEntryReadOnly(savedSessionKey).entry?.cliSessionBindings?.[
            "claude-cli"
          ];
        expect(saved?.authProfileId).toBe("anthropic:pasted");

        await gateway.client.request("sessions.patch", {
          key: sessionKey,
          model: `${modelRef}@anthropic:pasted`,
        });
        await sendTurn(
          gateway.client,
          sessionKey,
          "Reply using my explicit account selection.",
          "Saved account reply.",
        );
        const explicitlySelected =
          loadGatewaySessionEntryReadOnly(sessionKey).entry?.cliSessionBindings?.["claude-cli"];
        expect(explicitlySelected?.authProfileId).toBe("anthropic:pasted");
        expect(explicitlySelected?.sessionId).not.toBe(original?.sessionId);

        const replacement = {
          type: "token",
          provider: "anthropic",
          token: "synthetic-replacement-anthropic-token",
        } satisfies AuthProfileCredential;
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "anthropic:pasted": {
              type: "token",
              provider: "anthropic",
              token: "synthetic-pasted-anthropic-token",
            },
            "anthropic:replacement": replacement,
          },
          order: { anthropic: ["anthropic:replacement", "anthropic:pasted"] },
        });
        await sendTurn(
          gateway.client,
          savedSessionKey,
          "Keep our existing account despite the new default.",
          "Saved account reply.",
        );
        const retained =
          loadGatewaySessionEntryReadOnly(savedSessionKey).entry?.cliSessionBindings?.[
            "claude-cli"
          ];
        expect(retained?.authProfileId).toBe(saved?.authProfileId);
        expect(retained?.sessionId).toBe(saved?.sessionId);

        await state.writeAuthProfiles({
          version: 1,
          profiles: { "anthropic:replacement": replacement },
          order: { anthropic: ["anthropic:replacement"] },
        });
        await sendTurn(
          gateway.client,
          savedSessionKey,
          "Use the available account after my old account was removed.",
          "Replacement account reply.",
        );
        const replaced =
          loadGatewaySessionEntryReadOnly(savedSessionKey).entry?.cliSessionBindings?.[
            "claude-cli"
          ];
        expect(replaced?.authProfileId).toBe("anthropic:replacement");
        expect(replaced?.sessionId).not.toBe(saved?.sessionId);
        const turns: {
          sessionId: string;
          resume: boolean;
          savedToken: boolean;
          resumedHistory: unknown[];
        }[] = (await fs.readFile(path.join(nativeRoot, "turns.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(turns).toHaveLength(6);
        expect(turns[0]).toMatchObject({
          sessionId: original?.sessionId,
          resume: false,
          savedToken: false,
        });
        expect(turns[1]).toMatchObject({
          sessionId: original?.sessionId,
          resume: true,
          savedToken: false,
        });
        expect(JSON.stringify(turns[1]?.resumedHistory)).toContain(marker);
        expect(turns[2]).toMatchObject({ resume: false, savedToken: true, resumedHistory: [] });
        expect(turns[2]?.sessionId).not.toBe(original?.sessionId);
        expect(turns[3]).toMatchObject({
          sessionId: explicitlySelected?.sessionId,
          resume: false,
          savedToken: true,
          resumedHistory: [],
        });
        expect(turns[4]).toMatchObject({ sessionId: saved?.sessionId, savedToken: true });
        expect(turns[5]).toMatchObject({
          sessionId: replaced?.sessionId,
          resume: false,
          savedToken: true,
          resumedHistory: [],
        });
      }
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "CLI auth test cleanup" });
        }
      } finally {
        await state.cleanup();
      }
    }
  },
);
