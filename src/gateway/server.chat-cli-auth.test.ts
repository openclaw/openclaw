import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWindowsCmdShimFixture } from "../test-helpers/windows-cmd-shim.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

// Only the external executable is a fixture. The registered Gateway, Anthropic
// plugin, profile selection, credential transport, and transcript writer are real.
const CLAUDE_AUTH_FIXTURE = String.raw`
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.226 (Claude Code fixture)\n");
  process.exit(0);
}
if (process.argv.includes("auth")) {
  send({ loggedIn: false });
  process.exit(0);
}
const descriptor = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
let reply = "No managed credential supplied.";
if (descriptor !== undefined) {
  assert.equal(descriptor, "3");
  assert.equal(readFileSync(3, "utf8"), "synthetic-pasted-anthropic-token");
  reply = "Saved account reply.";
}
for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"]) {
  assert.equal(process.env[name], undefined);
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { commands: [], models: [] },
    } });
  } else if (message.type === "user") {
    send({ type: "assistant", message: {
      role: "assistant", content: [{ type: "text", text: reply }],
    } });
    send({ type: "result", subtype: "success", is_error: false,
      result: reply, session_id: message.session_id });
  }
});
`;

const cases: {
  name: string;
  order: NonNullable<OpenClawConfig["auth"]>["order"];
  credential: AuthProfileCredential;
  reply: string;
}[] = [
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

it.each(cases)("chat.send $name", { timeout: 90_000 }, async ({ order, credential, reply }) => {
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
    setTestEnvValue("CLAUDE_CONFIG_DIR", state.path("native-claude"));
    await state.writeAuthProfiles({
      version: 1,
      profiles: { "anthropic:pasted": credential },
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
    const accepted = await gateway.client.request<{ runId: string; status: string }>("chat.send", {
      sessionKey,
      message: "Reply using the saved account.",
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    expect(accepted.status).toBe("started");
    const completed = await gateway.client.request<{ status: string }>(
      "agent.wait",
      { runId: accepted.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    expect(completed.status).toBe("ok");
    const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
      sessionKey,
    });
    expect(history.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([{ type: "text", text: reply }]),
      }),
    );
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
});
