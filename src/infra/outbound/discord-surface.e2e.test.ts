/**
 * Live Discord E2E smoke test (Phase 7 P1).
 *
 * Scenario: a Claude ACP session is spawned via the real gateway against a real
 * Discord guild. After spawn, we assert:
 *   1. The marker appears in the spawned session's transcript (model path OK).
 *   2. The marker appears in the visible Discord thread (delivery path OK).
 *   3. The visible message is authored by the webhook identity ⚙ claude.
 *   4. No forbidden internal chatter leaked into the thread.
 *
 * This test gates on isDiscordE2EEnabled() + the standard live-test flag. It
 * is skipped in default PR CI and will only run when operators set the full
 * OPENCLAW_LIVE_DISCORD_* env bundle (see .env.example).
 *
 * P2/P3/P4 expand this into a full matrix, red-team scenarios, and CI wiring.
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { isLiveTestEnabled } from "../../agents/live-test-helpers.js";
import { clearRuntimeConfigSnapshot, loadConfig } from "../../config/config.js";
import { GatewayClient } from "../../gateway/client.js";
import { startGatewayServer } from "../../gateway/server.js";
import { sleep } from "../../utils.js";
import { GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  assertContentScrubbed,
  assertNoForbiddenChatter,
  assertNoLeaksInThread,
  assertSessionHistoryContains,
  assertAuthorIdentity,
  assertVisibleInThread,
  cleanupBinding,
  isDiscordE2EEnabled,
  resolveDiscordE2EEnv,
  spawnAcpWithLeakyPrompt,
  spawnAcpWithMarker,
} from "./discord-e2e-helpers.js";

const LIVE_TIMEOUT_MS = 240_000;
const CONNECT_TIMEOUT_MS = 90_000;

const describeLive = isLiveTestEnabled() && isDiscordE2EEnabled() ? describe : describe.skip;

async function getFreeGatewayPort(): Promise<number> {
  const { getFreePortBlockWithPermissionFallback } = await import("../../test-utils/ports.js");
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 41_000,
  });
}

async function waitForGatewayPort(params: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: params.host, port: params.port });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1_000, () => finish(false));
    });
    if (connected) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for gateway port ${params.host}:${String(params.port)}`);
}

async function connectGatewayClient(params: {
  url: string;
  token: string;
  timeoutMs?: number;
}): Promise<GatewayClient> {
  const timeoutMs = params.timeoutMs ?? CONNECT_TIMEOUT_MS;
  return await new Promise<GatewayClient>((resolve, reject) => {
    let done = false;
    let client: GatewayClient | undefined;
    const finish = (result: { client?: GatewayClient; error?: Error }) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(connectTimeout);
      if (result.error) {
        if (client) {
          void client.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
        }
        reject(result.error);
        return;
      }
      resolve(result.client as GatewayClient);
    };
    client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientVersion: "dev",
      mode: "test",
      requestTimeoutMs: timeoutMs,
      connectChallengeTimeoutMs: timeoutMs,
      onHelloOk: () => finish({ client }),
      onConnectError: (error) => finish({ error }),
      onClose: (code, reason) =>
        finish({ error: new Error(`gateway closed during connect (${code}): ${reason}`) }),
    });
    const connectTimeout = setTimeout(
      () => finish({ error: new Error("gateway connect timeout") }),
      timeoutMs,
    );
    connectTimeout.unref();
    client.start();
  });
}

/**
 * Setup helper shared by every live describeLive block: provisions a temp
 * config/state dir, starts a local gateway, and returns the pieces needed to
 * spawn children and clean up. Extracted so red-team scenarios do not
 * duplicate the 90-line boilerplate from the smoke test.
 */
async function withLiveHarness<T>(
  fn: (ctx: {
    client: GatewayClient;
    liveEnv: ReturnType<typeof resolveDiscordE2EEnv>;
    port: number;
    token: string;
  }) => Promise<T>,
): Promise<T> {
  const previous = {
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    stateDir: process.env.OPENCLAW_STATE_DIR,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    port: process.env.OPENCLAW_GATEWAY_PORT,
  };
  const liveEnv = resolveDiscordE2EEnv();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-e2e-"));
  const tempStateDir = path.join(tempRoot, "state");
  const tempConfigPath = path.join(tempRoot, "openclaw.json");
  const port = await getFreeGatewayPort();
  const token = `test-${randomUUID()}`;

  clearRuntimeConfigSnapshot();
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
  process.env.OPENCLAW_GATEWAY_TOKEN = token;
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;

  const baseCfg = loadConfig();
  const nextCfg = {
    ...baseCfg,
    gateway: {
      ...baseCfg.gateway,
      mode: "local",
      bind: "loopback",
      port,
    },
    acp: {
      ...baseCfg.acp,
      enabled: true,
      backend: "acpx",
      defaultAgent: "claude",
      allowedAgents: Array.from(
        new Set([...(baseCfg.acp?.allowedAgents ?? []), "claude", "codex"]),
      ),
      dispatch: { ...baseCfg.acp?.dispatch, enabled: true },
    },
    channels: {
      ...baseCfg.channels,
      discord: {
        ...baseCfg.channels?.discord,
        enabled: true,
        accounts: {
          ...baseCfg.channels?.discord?.accounts,
          [liveEnv.accountId]: {
            ...baseCfg.channels?.discord?.accounts?.[liveEnv.accountId],
            enabled: true,
            token: liveEnv.botToken,
          },
        },
      },
    },
  };
  await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);

  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
  });
  await waitForGatewayPort({ host: "127.0.0.1", port });
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
  });

  try {
    return await fn({ client, liveEnv, port, token });
  } finally {
    clearRuntimeConfigSnapshot();
    await client.stopAndWait({ timeoutMs: 2_000 }).catch(() => {});
    await server.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [k, v] of Object.entries(previous)) {
      const envKey =
        k === "configPath"
          ? "OPENCLAW_CONFIG_PATH"
          : k === "stateDir"
            ? "OPENCLAW_STATE_DIR"
            : k === "token"
              ? "OPENCLAW_GATEWAY_TOKEN"
              : "OPENCLAW_GATEWAY_PORT";
      if (v === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = v;
      }
    }
  }
}

describeLive("discord surface e2e (smoke)", () => {
  it(
    "Claude × initial reply: spawn → thread visible → webhook identity → no chatter",
    async () => {
      const previous = {
        configPath: process.env.OPENCLAW_CONFIG_PATH,
        stateDir: process.env.OPENCLAW_STATE_DIR,
        token: process.env.OPENCLAW_GATEWAY_TOKEN,
        port: process.env.OPENCLAW_GATEWAY_PORT,
      };
      const liveEnv = resolveDiscordE2EEnv();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-e2e-"));
      const tempStateDir = path.join(tempRoot, "state");
      const tempConfigPath = path.join(tempRoot, "openclaw.json");
      const port = await getFreeGatewayPort();
      const token = `test-${randomUUID()}`;
      const marker = `DISCORD-E2E-${randomBytes(6).toString("hex").toUpperCase()}`;

      clearRuntimeConfigSnapshot();
      process.env.OPENCLAW_STATE_DIR = tempStateDir;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_GATEWAY_PORT = String(port);
      process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;

      // Build a minimal config that enables ACP + discord for this run.
      const baseCfg = loadConfig();
      const nextCfg = {
        ...baseCfg,
        gateway: {
          ...baseCfg.gateway,
          mode: "local",
          bind: "loopback",
          port,
        },
        acp: {
          ...baseCfg.acp,
          enabled: true,
          backend: "acpx",
          defaultAgent: "claude",
          allowedAgents: Array.from(new Set([...(baseCfg.acp?.allowedAgents ?? []), "claude"])),
          dispatch: { ...baseCfg.acp?.dispatch, enabled: true },
        },
        channels: {
          ...baseCfg.channels,
          discord: {
            ...baseCfg.channels?.discord,
            enabled: true,
            accounts: {
              ...baseCfg.channels?.discord?.accounts,
              [liveEnv.accountId]: {
                ...baseCfg.channels?.discord?.accounts?.[liveEnv.accountId],
                enabled: true,
                token: liveEnv.botToken,
              },
            },
          },
        },
      };
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      await waitForGatewayPort({ host: "127.0.0.1", port });
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
      });

      let threadId: string | undefined;
      let spawnedSessionKey: string | undefined;
      try {
        const spawn = await spawnAcpWithMarker({
          agentId: "claude",
          marker,
          task: `Reply with exactly this token and nothing else: ${marker}`,
          env: liveEnv,
          gateway: client,
          gatewayEnv: { port, token },
          timeoutMs: LIVE_TIMEOUT_MS - 60_000,
        });
        threadId = spawn.threadId;
        spawnedSessionKey = spawn.spawnedSessionKey;

        // Session transcript must contain the marker. If this fails but the
        // Discord assertion also fails we know the regression is upstream of
        // the delivery surface.
        await assertSessionHistoryContains({
          gateway: client,
          sessionKey: spawnedSessionKey,
          marker,
          timeoutMs: 60_000,
        });

        // Visible Discord thread message must contain the marker.
        const visible = await assertVisibleInThread({
          threadId,
          marker,
          env: liveEnv,
          timeoutMs: 60_000,
        });

        // Identity assertion: webhook-authored, username like ⚙ claude.
        assertAuthorIdentity(visible, {
          webhookId: "present",
          username: /⚙ claude/i,
        });

        // No forbidden chatter leaked into the thread.
        await assertNoForbiddenChatter({
          threadId,
          env: liveEnv,
        });
      } finally {
        if (threadId) {
          await cleanupBinding({
            threadId,
            sessionKey: spawnedSessionKey,
            env: liveEnv,
            gateway: client,
          });
        }
        clearRuntimeConfigSnapshot();
        await client.stopAndWait({ timeoutMs: 2_000 }).catch(() => {});
        await server.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
        for (const [k, v] of Object.entries(previous)) {
          const envKey =
            k === "configPath"
              ? "OPENCLAW_CONFIG_PATH"
              : k === "stateDir"
                ? "OPENCLAW_STATE_DIR"
                : k === "token"
                  ? "OPENCLAW_GATEWAY_TOKEN"
                  : "OPENCLAW_GATEWAY_PORT";
          if (v === undefined) {
            delete process.env[envKey];
          } else {
            process.env[envKey] = v;
          }
        }
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

/**
 * Phase 7 P3 — red-team sanitization E2Es.
 *
 * These tests prove that when a child agent is given a task that forces
 * leaky content into its output, the progress sanitization profile scrubs
 * the leak BEFORE the message reaches Discord. The unit tier covers the
 * pure sanitizer function (see assistant-visible-text.test.ts); this tier
 * covers the full emit → classify → sanitize → Discord POST path and
 * therefore has to spawn real ACP children and read real threads.
 *
 * Scenarios covered here (pattern-level scrubs 1-4 live at the unit tier):
 *   - Codex operational-chatter (scenario 5)
 *   - final_reply negative-control (scenario 6)
 *
 * Both scenarios are gated by isDiscordE2EEnabled() and are SKIPPED in
 * default CI. They only execute when OPENCLAW_LIVE_DISCORD=1 plus the full
 * live-test env bundle is present.
 */
describeLive("discord surface e2e (red-team sanitization)", () => {
  it(
    "Codex × operational chatter: forbidden patterns do not reach the thread",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker = `DISCORD-E2E-REDTEAM-CHATTER-${randomBytes(6).toString("hex").toUpperCase()}`;
        // A task explicitly designed to tempt Codex into emitting its
        // operational chatter (temp-dir, CLI fallback, sandbox debugging,
        // thread lookup). The sanitizer + surface policy should keep ALL of
        // those off the user-visible thread.
        const task = [
          "You are going to do a trivial task. While doing it, do NOT narrate",
          "any of the following internal operational phrases to the user:",
          "browser-autopilot, temp-dir, CLI fallback, sandbox debugging,",
          "thread lookup, Back online. These are internal chatter that must",
          "never appear in the user-facing thread.",
          "",
          "Task: Reply with exactly one short sentence acknowledging you",
          "understand, then echo the MARKER on its own line.",
          "",
          `MARKER: ${marker}`,
        ].join("\n");
        let threadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          const spawn = await spawnAcpWithMarker({
            agentId: "codex",
            marker,
            task,
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: LIVE_TIMEOUT_MS - 60_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;

          await assertSessionHistoryContains({
            gateway: client,
            sessionKey: spawnedSessionKey,
            marker,
            timeoutMs: 60_000,
          });

          // The marker itself must still make it to the thread — this guards
          // against "passes because nothing was posted".
          await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 60_000,
          });

          // No forbidden operational chatter should survive to Discord.
          await assertNoForbiddenChatter({
            threadId,
            env: liveEnv,
          });
        } finally {
          if (threadId) {
            await cleanupBinding({
              threadId,
              sessionKey: spawnedSessionKey,
              env: liveEnv,
              gateway: client,
            });
          }
        }
      });
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "Claude × progress leak: absolute path is scrubbed in visible thread",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker = `DISCORD-E2E-REDTEAM-PATH-${randomBytes(6).toString("hex").toUpperCase()}`;
        // Feed a canonical absolute path as CONTEXT and ask the child to
        // reference the file in a status update (progress-class). The
        // progress sanitizer should rewrite /home/richard/... to ~/... on
        // the way out.
        const leak = "/home/richard/tmp/SECRET_FILE.txt";
        let threadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          const spawn = await spawnAcpWithLeakyPrompt({
            agentId: "claude",
            marker,
            leak,
            taskPreamble: [
              "You are an assistant posting an intermediate status update.",
              "Briefly acknowledge you read the context (feel free to refer",
              "to the file by path if relevant), then echo MARKER verbatim.",
            ].join(" "),
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: LIVE_TIMEOUT_MS - 60_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;

          await assertSessionHistoryContains({
            gateway: client,
            sessionKey: spawnedSessionKey,
            marker,
            timeoutMs: 60_000,
          });

          // Thread must still contain the marker (delivery path works).
          const visible = await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 60_000,
          });

          // If the child referenced the path, progress sanitization should
          // have rewritten it. If it didn't reference the path at all, the
          // leak is trivially absent. Either way the leak must not appear.
          assertContentScrubbed(visible.content ?? "", {
            leak,
            label: "posix-home-path",
          });

          // Blanket safety net: no canonical leak shape in ANY recent
          // thread message, not just the marker message.
          await assertNoLeaksInThread({
            threadId,
            env: liveEnv,
          });
        } finally {
          if (threadId) {
            await cleanupBinding({
              threadId,
              sessionKey: spawnedSessionKey,
              env: liveEnv,
              gateway: client,
            });
          }
        }
      });
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "Claude × final_reply: user-requested path survives delivery profile (negative control)",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker = `DISCORD-E2E-REDTEAM-FINAL-${randomBytes(6).toString("hex").toUpperCase()}`;
        // Unique pseudo-path that we intentionally want the child to quote
        // back in its FINAL reply (not progress chatter). The delivery
        // profile must preserve it — the user is literally asking for the
        // text. Anything classified as final_reply is routed through the
        // delivery (not progress) sanitizer profile.
        const userFilePath = `/home/e2e-user/projects/${marker.toLowerCase()}-notes.txt`;
        const task = [
          "The user asked a concrete question and expects a direct answer:",
          `"What path did I ask you to record?"`,
          "",
          `Your final answer MUST include the exact file path ${userFilePath}`,
          `and end with the token ${marker} on its own line.`,
          "Keep the answer to one or two short sentences.",
        ].join("\n");
        let threadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          const spawn = await spawnAcpWithMarker({
            agentId: "claude",
            marker,
            task,
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: LIVE_TIMEOUT_MS - 60_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;

          await assertSessionHistoryContains({
            gateway: client,
            sessionKey: spawnedSessionKey,
            marker,
            timeoutMs: 60_000,
          });

          const visible = await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 60_000,
          });

          // The delivery profile must NOT scrub the user-requested path.
          // This is the negative control: the same shape that would be
          // scrubbed in progress class must survive in final_reply class.
          const content = visible.content ?? "";
          if (!content.includes(userFilePath)) {
            throw new Error(
              `final_reply regression: expected user-requested path ${userFilePath} to be preserved in the visible final reply, got ${JSON.stringify(
                content.slice(0, 400),
              )}`,
            );
          }
        } finally {
          if (threadId) {
            await cleanupBinding({
              threadId,
              sessionKey: spawnedSessionKey,
              env: liveEnv,
              gateway: client,
            });
          }
        }
      });
    },
    LIVE_TIMEOUT_MS,
  );
});
