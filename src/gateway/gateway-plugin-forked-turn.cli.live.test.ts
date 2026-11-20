// Plugin session forks on a real Claude CLI session, with no Anthropic API key.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCliBackendConfig, type ResolvedCliBackend } from "../agents/cli-backends.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { isLiveTestEnabled, useLiveTestRuntimeConfig } from "../agents/live-test-helpers.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { setTestEnvValue } from "../test-utils/env.js";
import type { RuntimeBackendEntry } from "./gateway-cli-backend.live-cache.test-helpers.js";
import {
  applyCliBackendLiveEnv,
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
  getCliBackendPortBlock,
  resolveCliBackendLiveModelSelection,
  restoreCliBackendLiveEnv,
  snapshotCliBackendLiveEnv,
} from "./gateway-cli-backend.live-helpers.js";
import { startGatewayServer } from "./server.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";

const LIVE = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND);
const describeLive = LIVE ? describe : describe.skip;
const MODEL = process.env.OPENCLAW_LIVE_CLI_BACKEND_MODEL ?? "claude-cli/claude-sonnet-5";
const SESSION_KEY = "agent:dev:live-cli-fork";
const PROBE_PLUGIN_ID = "fork-probe";

const PROBE_SOURCE = `module.exports = { id: "${PROBE_PLUGIN_ID}", register(api) {
  const settle = (outcome) => outcome.ok
    ? { ok: true, text: outcome.text ?? "" }
    : { ok: false, cancelled: outcome.cancelled, error: String(outcome.error?.message ?? outcome.error) };
  api.registerGatewayMethod("forkprobe.run", async ({ params, respond }) => {
    try {
      const result = await api.runtime.subagent.runForkedTurn({
        sessionKey: params.sessionKey, prompt: params.prompt, tools: params.tools,
        timeoutMs: 240000, onSettled: settle,
      });
      respond(true, { result });
    } catch (error) {
      respond(true, { threw: String(error?.message ?? error) });
    }
  }, { scope: "operator.write" });
  api.registerGatewayMethod("forkprobe.side", async ({ params, respond }) => {
    try {
      respond(true, { result: await api.runtime.subagent.forkSession({
        sessionKey: params.sessionKey, message: params.message, timeoutMs: 240000,
      }) });
    } catch (error) {
      respond(true, { threw: String(error?.message ?? error) });
    }
  }, { scope: "operator.write" });
} };`;

function runtimeBackendEntry(backend: ResolvedCliBackend): RuntimeBackendEntry {
  const { ownsNativeCompaction, manualCompaction, ...rest } = backend;
  const base = { ...rest, pluginId: backend.pluginId ?? backend.id };
  return ownsNativeCompaction === true
    ? { ...base, ownsNativeCompaction: true, manualCompaction }
    : { ...base, ownsNativeCompaction: false };
}

/** Prints one proof line; the run log is the reviewer's runtime output. */
function proof(label: string, value: unknown) {
  console.error(
    `[cli-fork-live] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}

/**
 * The CLI's own transcript of a native session: first 16 hex of its sha256, and how many native
 * sessions its project folder holds (a kept fork successor would add one).
 */
async function nativeSession(sessionId: string | undefined) {
  const projects = path.join(os.homedir(), ".claude", "projects");
  for (const project of sessionId ? await fs.readdir(projects).catch(() => []) : []) {
    const dir = path.join(projects, project);
    const bytes = await fs.readFile(path.join(dir, `${sessionId}.jsonl`)).catch(() => undefined);
    if (bytes) {
      const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".jsonl")).length;
      return { sha: createHash("sha256").update(bytes).digest("hex").slice(0, 16), files };
    }
  }
  return { sha: "missing", files: 0 };
}

describeLive("gateway live (plugin forks on a CLI session)", () => {
  it(
    "forks the Claude CLI native session without an API key",
    { timeout: 20 * 60_000 },
    async () => {
      const previousEnv = snapshotCliBackendLiveEnv();
      clearRuntimeConfigSnapshot();
      // Removes ANTHROPIC_API_KEY: the session runs only on the CLI's own login.
      applyCliBackendLiveEnv(new Set());
      const token = `test-${randomUUID()}`;
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      const port = await getCliBackendPortBlock();
      const selection = resolveCliBackendLiveModelSelection({
        rawModel: MODEL,
        defaultProvider: "claude-cli",
      });
      const backend = resolveCliBackendConfig(selection.providerId);
      if (!backend) {
        throw new Error(`missing CLI backend ${selection.providerId}`);
      }
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [runtimeBackendEntry(backend)],
      });
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-cli-fork-"));
      const stateDir = path.join(tempDir, "state");
      const workspaceDir = path.join(tempDir, "workspace");
      const pluginDir = path.join(tempDir, PROBE_PLUGIN_ID);
      await Promise.all([
        fs.mkdir(stateDir, { recursive: true }),
        fs.mkdir(workspaceDir, { recursive: true }),
        fs.mkdir(pluginDir, { recursive: true }),
      ]);
      await fs.writeFile(path.join(workspaceDir, "probe-note.txt"), "FORK-READ-OK 7f3a\n");
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: PROBE_PLUGIN_ID,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: PROBE_PLUGIN_ID,
          activation: { onStartup: true },
          configSchema: { type: "object" },
          contracts: { tools: [] },
        }),
      );
      await fs.writeFile(path.join(pluginDir, "index.cjs"), PROBE_SOURCE);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const config: OpenClawConfig = {
        gateway: { mode: "local", port, auth: { mode: "token", token } },
        plugins: {
          enabled: true,
          load: { paths: [pluginDir] },
          entries: {
            [PROBE_PLUGIN_ID]: { enabled: true, hooks: { allowConversationAccess: true } },
          },
        },
        agents: {
          defaults: {
            workspace: workspaceDir,
            skipBootstrap: true,
            model: { primary: selection.configModelKey },
            models: { [selection.configModelKey]: { agentRuntime: selection.agentRuntime } },
            sandbox: { mode: "off" },
          },
          entries: { dev: {} },
        },
      };
      const configPath = path.join(tempDir, "openclaw.json");
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      using _ = useLiveTestRuntimeConfig(config);
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity();
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      const client = await connectTestGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        deviceIdentity,
      }).catch(async (error: unknown) => {
        await server.close();
        throw error;
      });
      try {
        await server.startupSettled;
        proof("ANTHROPIC_API_KEY set", Boolean(process.env.ANTHROPIC_API_KEY));
        proof("model", `${selection.configModelKey} runtime=${selection.agentRuntime.id}`);
        const turn = await client.request<{ status?: string }>(
          "agent",
          {
            sessionKey: SESSION_KEY,
            idempotencyKey: `idem-${randomUUID()}`,
            message: "Remember the code word PELICAN-42. Reply with just OK.",
            deliver: false,
          },
          { expectFinal: true, timeoutMs: 10 * 60_000 },
        );
        proof("parent turn", turn.status);
        expect(turn.status).toBe("ok");

        const readSource = async () => {
          const target = await loadGatewaySessionEntryReadOnlyAsync(SESSION_KEY);
          const history = await client.request<{ messages?: unknown[] }>("chat.history", {
            sessionKey: SESSION_KEY,
          });
          const native = target.entry?.cliSessionBindings?.[selection.providerId]?.sessionId;
          return {
            messages: history.messages?.length ?? 0,
            historySha: createHash("sha256")
              .update(JSON.stringify(history.messages))
              .digest("hex")
              .slice(0, 16),
            native,
            nativeTranscript: await nativeSession(native),
          };
        };
        const before = await readSource();
        proof("source before forks", before);

        const forkA = await client.request(
          "forkprobe.run",
          {
            sessionKey: SESSION_KEY,
            tools: ["read", "ls"],
            prompt:
              "What code word did I ask you to remember? Then use your file tools to read probe-note.txt in your workspace and quote its first line. Answer on one line: <word> | <line>.",
          },
          { timeoutMs: 6 * 60_000 },
        );
        proof("fork A runForkedTurn tools=[read,ls]", forkA);

        const forkB = await client.request(
          "forkprobe.run",
          {
            sessionKey: SESSION_KEY,
            tools: ["read"],
            prompt: `Run the shell command: touch ${path.join(workspaceDir, "exec-ran.txt")} . If you have no tool that can run shell commands, reply exactly EXEC-UNAVAILABLE.`,
          },
          { timeoutMs: 6 * 60_000 },
        );
        proof("fork B runForkedTurn tools=[read], asked to run a shell command", forkB);
        const execRan = await fs.access(path.join(workspaceDir, "exec-ran.txt")).then(
          () => true,
          () => false,
        );
        proof("exec-ran.txt created by fork B", execRan);

        const forkC = await client.request(
          "forkprobe.run",
          {
            sessionKey: SESSION_KEY,
            tools: ["write"],
            prompt: "Write a file.",
          },
          { timeoutMs: 60_000 },
        );
        proof("fork C runForkedTurn tools=[write]", forkC);

        const forkD = await client.request(
          "forkprobe.side",
          {
            sessionKey: SESSION_KEY,
            message: "What code word did I ask you to remember? Reply with the word only.",
          },
          { timeoutMs: 6 * 60_000 },
        );
        proof("fork D forkSession", forkD);

        const after = await readSource();
        proof("source after forks", after);
        proof("source transcript unchanged", before.historySha === after.historySha);
        proof(
          "source native session and binding unchanged",
          before.native === after.native &&
            before.nativeTranscript.sha === after.nativeTranscript.sha,
        );
        proof(
          "no fork session kept on disk",
          before.nativeTranscript.files === after.nativeTranscript.files,
        );

        expect(JSON.stringify(forkA)).toContain("PELICAN-42");
        expect(JSON.stringify(forkA)).toContain("FORK-READ-OK 7f3a");
        expect(execRan).toBe(false);
        expect(JSON.stringify(forkD)).toContain("PELICAN-42");
        expect(after).toEqual(before);
      } finally {
        await client.stopAndWait();
        await server.close();
        cliBackendsTesting.resetDepsForTest();
        restoreCliBackendLiveEnv(previousEnv);
        clearRuntimeConfigSnapshot();
      }
    },
  );
});
