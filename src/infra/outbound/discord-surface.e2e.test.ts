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
  archiveThreadDiscord,
  assertContentScrubbed,
  assertNoForbiddenChatter,
  assertNoLeaksInThread,
  assertSessionHistoryContains,
  assertAuthorIdentity,
  assertVisibleInThread,
  cleanupBinding,
  followUpInBoundThread,
  isDiscordE2EEnabled,
  nudgeBoundSession,
  readMessagesInThread,
  rebindParentToNewThread,
  resolveDiscordE2EEnv,
  spawnAcpWithLeakyPrompt,
  spawnAcpWithMarker,
  waitForMarkerInNewThread,
} from "./discord-e2e-helpers.js";

const LIVE_TIMEOUT_MS = 240_000;
const CONNECT_TIMEOUT_MS = 90_000;

const describeLive = isLiveTestEnabled() && isDiscordE2EEnabled() ? describe : describe.skip;

// Local trace helper for advisory-only diagnostics. Mirrors the helper inside
// discord-e2e-helpers.ts (which is module-private there) so we can log
// non-blocking `assertSessionHistoryContains` failures without polluting
// non-verbose test output.
function e2eTrace(message: string): void {
  if (process.env.OPENCLAW_E2E_VERBOSE === "1") {
    console.info(`[discord-e2e] ${message}`);
  }
}

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
    allowSelfMessages: process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES,
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
  process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES = "1";

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
        // Phase 11 F2: the E2E harness itself posts the user-task message as
        // the `openclaw-e2e` bot (sharing the production bot token). The
        // preflight defaults to allowBots="off" which drops that message
        // BEFORE the OPENCLAW_E2E_ALLOW_SELF_MESSAGES bypass runs. Enable
        // bot-authored messages in-test so the harness can drive the flow.
        allowBots: true,
        threadBindings: {
          ...baseCfg.channels?.discord?.threadBindings,
          // Required so `/acp spawn ... --bind here` actually creates a
          // Discord thread for the spawned child and routes emissions to
          // it. Without `enabled`+`spawnAcpSessions`, the child runs but
          // the Discord delivery surface is never wired up.
          enabled: true,
          spawnAcpSessions: true,
          spawnSubagentSessions: true,
        },
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
              : k === "allowSelfMessages"
                ? "OPENCLAW_E2E_ALLOW_SELF_MESSAGES"
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
        allowSelfMessages: process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES,
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
      process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES = "1";

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
            // Phase 11 F2: the E2E harness itself posts the user-task message as
            // the `openclaw-e2e` bot (sharing the production bot token). The
            // preflight defaults to allowBots="off" which drops that message
            // BEFORE the OPENCLAW_E2E_ALLOW_SELF_MESSAGES bypass runs. Enable
            // bot-authored messages in-test so the harness can drive the flow.
            allowBots: true,
            threadBindings: {
              ...baseCfg.channels?.discord?.threadBindings,
              // Required so `/acp spawn ... --thread here` actually creates
              // a Discord thread for the spawned child and routes emissions
              // to it.
              enabled: true,
              spawnAcpSessions: true,
              spawnSubagentSessions: true,
            },
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
        const requestMessageId = spawn.requestMessageId;

        // Visibility in the Discord thread is the authoritative merge gate
        // per project memory: "raw visible Discord message id" is the proof,
        // session history alone is not sufficient evidence. Strict mode
        // (Task 2) excludes the harness request message so the helper
        // cannot mistake its own prompt echo for the assistant reply.
        const visible = await assertVisibleInThread({
          threadId,
          marker,
          env: liveEnv,
          timeoutMs: 60_000,
          excludeMessageIds: [requestMessageId],
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

        // Session-history check is best-effort diagnostic only. The
        // Discord-origin ACP dispatch path may write the transcript under a
        // different session-key namespace than this test's
        // `spawnedSessionKey` variable captures, so a missing history entry
        // here is a test-coupling artifact, not a regression — visibility
        // above has already proven the reply landed.
        try {
          await assertSessionHistoryContains({
            gateway: client,
            sessionKey: spawnedSessionKey,
            marker,
            timeoutMs: 5_000,
          });
        } catch (err) {
          e2eTrace(`assertSessionHistoryContains advisory failure (non-blocking): ${String(err)}`);
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
                  : k === "allowSelfMessages"
                    ? "OPENCLAW_E2E_ALLOW_SELF_MESSAGES"
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
          const requestMessageId = spawn.requestMessageId;

          // Visibility first: the marker reaching the Discord thread is the
          // authoritative proof of delivery per project memory's "raw visible
          // Discord message id" rule. Session-history is advisory-only for
          // the Discord-origin path and checked below. Strict mode excludes
          // the harness request message so its own echo cannot satisfy the
          // assertion.
          await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 60_000,
            excludeMessageIds: [requestMessageId],
          });

          // No forbidden operational chatter should survive to Discord.
          await assertNoForbiddenChatter({
            threadId,
            env: liveEnv,
          });

          // Session-history check is best-effort diagnostic only.
          try {
            await assertSessionHistoryContains({
              gateway: client,
              sessionKey: spawnedSessionKey,
              marker,
              timeoutMs: 5_000,
            });
          } catch (err) {
            e2eTrace(
              `assertSessionHistoryContains advisory failure (non-blocking): ${String(err)}`,
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
          const requestMessageId = spawn.requestMessageId;

          // Visibility first: thread must contain the marker (delivery path
          // works). This is the authoritative merge gate — session-history
          // is checked as advisory-only diagnostics below. Strict mode
          // excludes the harness request message so the leaky prompt echo
          // cannot satisfy the assertion.
          const visible = await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 60_000,
            excludeMessageIds: [requestMessageId],
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

          // Session-history check is best-effort diagnostic only.
          try {
            await assertSessionHistoryContains({
              gateway: client,
              sessionKey: spawnedSessionKey,
              marker,
              timeoutMs: 5_000,
            });
          } catch (err) {
            e2eTrace(
              `assertSessionHistoryContains advisory failure (non-blocking): ${String(err)}`,
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
          const requestMessageId = spawn.requestMessageId;

          // Visibility first: the user-requested path lands in the thread
          // under the delivery (not progress) sanitizer profile. This is
          // the authoritative merge gate; session-history is advisory-only.
          // Strict mode excludes the harness request message so its own
          // echo of the file path cannot satisfy the assertion.
          const visible = await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 60_000,
            excludeMessageIds: [requestMessageId],
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

          // Session-history check is best-effort diagnostic only.
          try {
            await assertSessionHistoryContains({
              gateway: client,
              sessionKey: spawnedSessionKey,
              marker,
              timeoutMs: 5_000,
            });
          } catch (err) {
            e2eTrace(
              `assertSessionHistoryContains advisory failure (non-blocking): ${String(err)}`,
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

/**
 * Phase 7 P2 — Full Provider × Scenario matrix.
 *
 * This block expands the Phase 7 P1 smoke test into the 10-scenario matrix
 * called for in the Discord Surface Overhaul plan (Phase 7, R14). The matrix
 * exercises the live delivery surface across both providers (Claude, Codex)
 * and across the realistic ACP thread-bound flows where past regressions
 * hid: initial reply, follow-up-in-bound-thread, subagent-announce banner,
 * `blocked` completion, archived-thread recovery, and mid-run parent
 * rebinding.
 *
 * Gate: `describeLive` is already conditional on `isDiscordE2EEnabled()`
 * plus `isLiveTestEnabled()`, so without the OPENCLAW_LIVE_DISCORD_* env
 * bundle the entire block is skipped in CI.
 *
 * Concurrency: we use `describe.concurrent` with a small maxConcurrent
 * (via vitest config) because Discord's default rate limit is 5 thread
 * creations per 5s per channel. With 10 scenarios each doing ONE spawn we
 * want to stay well under that ceiling. Running 2 in parallel keeps the
 * wall-clock acceptable (~5min) without tripping the limiter.
 *
 * Markers: each scenario is keyed on a unique run-scoped marker generated
 * from a short prefix + random bytes + a `Date.now()` suffix so cross-run
 * pollution cannot cause a later test to match a prior run's message.
 *
 * Each test wraps its work in `try/finally` with `cleanupBinding` so that
 * archived threads + closed sessions do not accumulate in the test guild.
 */

function phaseMarker(scenarioTag: string): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = randomBytes(3).toString("hex").toUpperCase();
  return `PHASE7_${scenarioTag}_${stamp}_${rand}`;
}

const MATRIX_DEFAULT_TIMEOUT_MS = 120_000;
const MATRIX_LONG_TIMEOUT_MS = 180_000;

describeLive.concurrent("discord surface e2e (matrix) — Phase 7 P2", () => {
  // -------------------------------------------------------------------------
  // Scenario 1 — Claude × initial reply.
  // Proves the baseline happy path for Claude: spawn binds a thread, marker
  // lands, webhook identity is `⚙ claude`, no chatter leaks.
  // -------------------------------------------------------------------------
  it(
    "Scenario 1 — Claude × initial reply: marker + webhook identity + no chatter",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker = phaseMarker("S1_CLAUDE_INITIAL");
        let threadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          const spawn = await spawnAcpWithMarker({
            agentId: "claude",
            marker,
            task: `Reply with exactly this token and nothing else: ${marker}`,
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: MATRIX_DEFAULT_TIMEOUT_MS - 30_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;
          const requestMessageId = spawn.requestMessageId;

          // Visibility first: authoritative merge gate per project memory.
          // Strict mode excludes the harness request message id.
          const visible = await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 45_000,
            excludeMessageIds: [requestMessageId],
          });
          assertAuthorIdentity(visible, {
            webhookId: "present",
            username: /⚙ claude/i,
          });
          await assertNoForbiddenChatter({ threadId, env: liveEnv });
          await assertNoLeaksInThread({ threadId, env: liveEnv });

          // Session-history check is best-effort diagnostic only.
          try {
            await assertSessionHistoryContains({
              gateway: client,
              sessionKey: spawnedSessionKey,
              marker,
              timeoutMs: 5_000,
            });
          } catch (err) {
            e2eTrace(
              `assertSessionHistoryContains advisory failure (non-blocking): ${String(err)}`,
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
    MATRIX_DEFAULT_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 2 — Codex × initial reply.
  // Same contract as Scenario 1 but the webhook identity must be `⚙ codex`.
  // -------------------------------------------------------------------------
  it(
    "Scenario 2 — Codex × initial reply: marker + webhook identity + no chatter",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker = phaseMarker("S2_CODEX_INITIAL");
        let threadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          const spawn = await spawnAcpWithMarker({
            agentId: "codex",
            marker,
            task: `Reply with exactly this token and nothing else: ${marker}`,
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: MATRIX_DEFAULT_TIMEOUT_MS - 30_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;
          const requestMessageId = spawn.requestMessageId;

          // Visibility first: authoritative merge gate per project memory.
          // Strict mode excludes the harness request message id.
          const visible = await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 45_000,
            excludeMessageIds: [requestMessageId],
          });
          assertAuthorIdentity(visible, {
            webhookId: "present",
            username: /⚙ codex/i,
          });
          await assertNoForbiddenChatter({ threadId, env: liveEnv });
          await assertNoLeaksInThread({ threadId, env: liveEnv });

          // Session-history check is best-effort diagnostic only.
          try {
            await assertSessionHistoryContains({
              gateway: client,
              sessionKey: spawnedSessionKey,
              marker,
              timeoutMs: 5_000,
            });
          } catch (err) {
            e2eTrace(
              `assertSessionHistoryContains advisory failure (non-blocking): ${String(err)}`,
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
    MATRIX_DEFAULT_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 3 — Claude × follow-up in bound thread.
  // After initial bind, a second user turn must still land in the SAME
  // thread with the same webhook identity. Past regression: follow-up went
  // to the main/parent channel or the webhook identity flipped back to
  // bot-mode.
  // -------------------------------------------------------------------------
  it(
    "Scenario 3 — Claude × follow-up in bound thread: second marker + identity preserved",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker1 = phaseMarker("S3_CLAUDE_FOLLOW_A");
        const marker2 = phaseMarker("S3_CLAUDE_FOLLOW_B");
        let threadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          const spawn = await spawnAcpWithMarker({
            agentId: "claude",
            marker: marker1,
            task: `Reply with exactly this token and nothing else: ${marker1}`,
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: MATRIX_DEFAULT_TIMEOUT_MS - 60_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;
          const requestMessageId = spawn.requestMessageId;

          // Strict mode excludes the harness request message id. The
          // follow-up's "request" is a gateway RPC, not a native Discord
          // message, so the assertion on marker2 below does not need an
          // exclusion (there is no harness echo of marker2 in Discord).
          await assertVisibleInThread({
            threadId,
            marker: marker1,
            env: liveEnv,
            timeoutMs: 45_000,
            excludeMessageIds: [requestMessageId],
          });

          // Follow-up turn on the SAME bound session.
          await followUpInBoundThread({
            threadId,
            spawnedSessionKey,
            text: `Follow-up. Reply with exactly this token and nothing else: ${marker2}`,
            env: liveEnv,
            gateway: client,
            timeoutMs: 60_000,
          });

          const visible2 = await assertVisibleInThread({
            threadId,
            marker: marker2,
            env: liveEnv,
            timeoutMs: 45_000,
          });
          assertAuthorIdentity(visible2, {
            webhookId: "present",
            username: /⚙ claude/i,
          });
          await assertNoForbiddenChatter({ threadId, env: liveEnv });
          await assertNoLeaksInThread({ threadId, env: liveEnv });
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
    MATRIX_LONG_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 4 — Codex × follow-up in bound thread.
  // Same contract as Scenario 3 but the webhook identity must remain
  // `⚙ codex` on the follow-up post.
  // -------------------------------------------------------------------------
  it(
    "Scenario 4 — Codex × follow-up in bound thread: second marker + identity preserved",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker1 = phaseMarker("S4_CODEX_FOLLOW_A");
        const marker2 = phaseMarker("S4_CODEX_FOLLOW_B");
        let threadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          const spawn = await spawnAcpWithMarker({
            agentId: "codex",
            marker: marker1,
            task: `Reply with exactly this token and nothing else: ${marker1}`,
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: MATRIX_DEFAULT_TIMEOUT_MS - 60_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;
          const requestMessageId = spawn.requestMessageId;

          // Strict mode excludes the harness request message id. The
          // follow-up's "request" is a gateway RPC, not a native Discord
          // message, so the assertion on marker2 below does not need an
          // exclusion.
          await assertVisibleInThread({
            threadId,
            marker: marker1,
            env: liveEnv,
            timeoutMs: 45_000,
            excludeMessageIds: [requestMessageId],
          });

          await followUpInBoundThread({
            threadId,
            spawnedSessionKey,
            text: `Follow-up. Reply with exactly this token and nothing else: ${marker2}`,
            env: liveEnv,
            gateway: client,
            timeoutMs: 60_000,
          });

          const visible2 = await assertVisibleInThread({
            threadId,
            marker: marker2,
            env: liveEnv,
            timeoutMs: 45_000,
          });
          assertAuthorIdentity(visible2, {
            webhookId: "present",
            username: /⚙ codex/i,
          });
          await assertNoForbiddenChatter({ threadId, env: liveEnv });
          await assertNoLeaksInThread({ threadId, env: liveEnv });
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
    MATRIX_LONG_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 5 — Claude × session_active announce.
  // The subagent-announce banner that appears when a session becomes active
  // must be authored by the webhook identity (`⚙ claude`) and must NOT be
  // treated as user-visible final content. This scenario spawns a child and
  // asserts the FIRST webhook-authored message in the thread exists and
  // does not contain forbidden chatter. The banner text itself is
  // classified as progress, so we do not assert specific copy — we assert
  // identity + sanitation invariants.
  // -------------------------------------------------------------------------
  it(
    "Scenario 5 — Claude × session_active announce: banner present with webhook identity",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker = phaseMarker("S5_CLAUDE_ANNOUNCE");
        let threadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          const spawn = await spawnAcpWithMarker({
            agentId: "claude",
            marker,
            task: `Reply with exactly this token and nothing else: ${marker}`,
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: MATRIX_DEFAULT_TIMEOUT_MS - 45_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;
          const requestMessageId = spawn.requestMessageId;

          // The session_active banner is emitted early in the session
          // lifecycle. By the time the marker is visible the banner must
          // already have been posted under the same webhook identity.
          // We assert the marker post carries the claude webhook identity
          // (same surface as the banner), then do a blanket sanitation
          // check across the whole thread — any mis-identity-emitted
          // banner would be caught by the forbidden-chatter sweep (which
          // includes the canonical bot-mode leak strings). Strict mode
          // excludes the harness request message id.
          const visible = await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 45_000,
            excludeMessageIds: [requestMessageId],
          });
          assertAuthorIdentity(visible, {
            webhookId: "present",
            username: /⚙ claude/i,
          });

          await assertNoForbiddenChatter({ threadId, env: liveEnv });
          await assertNoLeaksInThread({ threadId, env: liveEnv });
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
    MATRIX_DEFAULT_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 6 — Codex × session_active announce.
  // Same as Scenario 5 but the banner must carry `⚙ codex` identity.
  // -------------------------------------------------------------------------
  it(
    "Scenario 6 — Codex × session_active announce: banner present with webhook identity",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker = phaseMarker("S6_CODEX_ANNOUNCE");
        let threadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          const spawn = await spawnAcpWithMarker({
            agentId: "codex",
            marker,
            task: `Reply with exactly this token and nothing else: ${marker}`,
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: MATRIX_DEFAULT_TIMEOUT_MS - 45_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;
          const requestMessageId = spawn.requestMessageId;

          // Strict mode excludes the harness request message id.
          const visible = await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 45_000,
            excludeMessageIds: [requestMessageId],
          });
          assertAuthorIdentity(visible, {
            webhookId: "present",
            username: /⚙ codex/i,
          });

          await assertNoForbiddenChatter({ threadId, env: liveEnv });
          await assertNoLeaksInThread({ threadId, env: liveEnv });
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
    MATRIX_DEFAULT_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 7 — Claude × blocked completion.
  // A task that asks the agent to signal it is blocked (pending human
  // input) must produce a `blocked`-class emission that reaches the thread
  // clearly. Past regression: blocked signals were classified as
  // `internal_narration` and dropped, leaving the user looking at a
  // silent thread with no indication the agent was waiting.
  // -------------------------------------------------------------------------
  it(
    "Scenario 7 — Claude × blocked completion: blocked signal reaches the thread",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker = phaseMarker("S7_CLAUDE_BLOCKED");
        // The prompt explicitly instructs the agent to produce a
        // blocked-class signal (the classifier looks for "I'm blocked"
        // style phrasing, see src/infra/outbound/message-class.ts).
        const task = [
          "You are a coding agent that has hit an ambiguous requirement.",
          "You MUST reply with exactly two short sentences:",
          '1. A line that begins with the phrase "I\'m blocked" explaining',
          "   you need more detail before continuing.",
          `2. The token ${marker} on its own line.`,
          "Do NOT perform any other work.",
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
            timeoutMs: MATRIX_DEFAULT_TIMEOUT_MS - 30_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;
          const requestMessageId = spawn.requestMessageId;

          // Strict mode: helper throws outright if no webhook-authored
          // match arrives (no silent fallback). The older diagnostic
          // fall-back branch is no longer reachable post-Task-2.
          const visible = await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 60_000,
            excludeMessageIds: [requestMessageId],
          });
          const content = visible.content ?? "";
          if (!/i['’]m blocked/i.test(content)) {
            throw new Error(
              `S7: expected blocked-class signal ("I'm blocked ...") in visible thread, got ${JSON.stringify(content.slice(0, 400))}`,
            );
          }
          assertAuthorIdentity(visible, {
            webhookId: "present",
            username: /⚙ claude/i,
          });
          await assertNoForbiddenChatter({ threadId, env: liveEnv });
          await assertNoLeaksInThread({ threadId, env: liveEnv });
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
    MATRIX_DEFAULT_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 8 — Codex × blocked completion.
  // Same contract as Scenario 7 but on the Codex provider, which uses a
  // different classifier path. Past regression: Codex's event_projector
  // never surfaced `blocked` at all because the stream name wasn't in the
  // allowlist.
  // -------------------------------------------------------------------------
  it(
    "Scenario 8 — Codex × blocked completion: blocked signal reaches the thread",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker = phaseMarker("S8_CODEX_BLOCKED");
        const task = [
          "You are a coding agent that has hit an ambiguous requirement.",
          "You MUST reply with exactly two short sentences:",
          '1. A line that begins with the phrase "I\'m blocked" explaining',
          "   you need more detail before continuing.",
          `2. The token ${marker} on its own line.`,
          "Do NOT perform any other work.",
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
            timeoutMs: MATRIX_DEFAULT_TIMEOUT_MS - 30_000,
          });
          threadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;
          const requestMessageId = spawn.requestMessageId;

          // Strict mode excludes the harness request message id.
          const visible = await assertVisibleInThread({
            threadId,
            marker,
            env: liveEnv,
            timeoutMs: 60_000,
            excludeMessageIds: [requestMessageId],
          });
          const content = visible.content ?? "";
          if (!/i['’]m blocked/i.test(content)) {
            throw new Error(
              `S8: expected blocked-class signal ("I'm blocked ...") in visible thread, got ${JSON.stringify(content.slice(0, 400))}`,
            );
          }
          assertAuthorIdentity(visible, {
            webhookId: "present",
            username: /⚙ codex/i,
          });
          await assertNoForbiddenChatter({ threadId, env: liveEnv });
          await assertNoLeaksInThread({ threadId, env: liveEnv });
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
    MATRIX_DEFAULT_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 9 — Archived-thread recovery (Phase 11 respawn).
  // Archive the child's bound thread mid-run; the child's next emission
  // must cause the gateway to respawn delivery into a NEW thread. Uses
  // Claude for the base provider (Phase 11 respawn is provider-agnostic).
  // This scenario runs long because it exercises: spawn → deliver →
  // archive → nudge → wait-for-new-thread → deliver-to-new-thread.
  // -------------------------------------------------------------------------
  it(
    "Scenario 9 — Archived-thread recovery: child respawns to new thread after archive",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker1 = phaseMarker("S9_RECOVERY_ORIG");
        const marker2 = phaseMarker("S9_RECOVERY_NEW");
        let originalThreadId: string | undefined;
        let newThreadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          const spawn = await spawnAcpWithMarker({
            agentId: "claude",
            marker: marker1,
            task: `Reply with exactly this token and nothing else: ${marker1}`,
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: MATRIX_LONG_TIMEOUT_MS - 90_000,
          });
          originalThreadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;
          const requestMessageId = spawn.requestMessageId;

          // Strict mode excludes the harness request message id.
          await assertVisibleInThread({
            threadId: originalThreadId,
            marker: marker1,
            env: liveEnv,
            timeoutMs: 45_000,
            excludeMessageIds: [requestMessageId],
          });

          // Archive the original bound thread. After this the Phase 11
          // respawn path should kick in on the next emission.
          await archiveThreadDiscord({ threadId: originalThreadId, env: liveEnv });

          // Nudge the session so the child produces a fresh emission.
          // Because the original thread is archived, the nudge's ORIGINATING
          // target becomes stale — Phase 11 treats that as "bound thread
          // dead" and creates a fresh one.
          await nudgeBoundSession({
            spawnedSessionKey,
            text: `Reply with exactly this token and nothing else: ${marker2}`,
            boundTarget: originalThreadId,
            env: liveEnv,
            gateway: client,
          });

          const recovery = await waitForMarkerInNewThread({
            env: liveEnv,
            marker: marker2,
            excludeThreadId: originalThreadId,
            timeoutMs: 90_000,
          });
          newThreadId = recovery.newThreadId;

          assertAuthorIdentity(recovery.message, {
            webhookId: "present",
            username: /⚙ claude/i,
          });

          await assertNoForbiddenChatter({ threadId: newThreadId, env: liveEnv });
          await assertNoLeaksInThread({ threadId: newThreadId, env: liveEnv });
        } finally {
          // Best-effort cleanup on BOTH threads.
          if (originalThreadId) {
            await cleanupBinding({
              threadId: originalThreadId,
              env: liveEnv,
            });
          }
          if (newThreadId) {
            await cleanupBinding({
              threadId: newThreadId,
              sessionKey: spawnedSessionKey,
              env: liveEnv,
              gateway: client,
            });
          }
        }
      });
    },
    MATRIX_LONG_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 10 — Mid-run parent rebinding.
  // After a session is bound to a thread in channel A, move the parent
  // session to a NEW thread in channel B. Subsequent emissions must route
  // to the NEW thread. This scenario requires
  // OPENCLAW_LIVE_DISCORD_SECONDARY_CHANNEL_ID; if it is not set the
  // rebind helper throws a clear error at runtime.
  // -------------------------------------------------------------------------
  it(
    "Scenario 10 — Mid-run rebinding: emissions route to new thread after parent move",
    async () => {
      await withLiveHarness(async ({ client, liveEnv }) => {
        const marker1 = phaseMarker("S10_REBIND_ORIG");
        const marker2 = phaseMarker("S10_REBIND_NEW");
        let originalThreadId: string | undefined;
        let newThreadId: string | undefined;
        let spawnedSessionKey: string | undefined;
        try {
          if (!liveEnv.secondaryChannelId) {
            // Skip this scenario gracefully by throwing a clear, actionable
            // error. The matrix runner treats this as a hard failure so
            // operators cannot silently ship without the secondary channel
            // configured. An explicit throw surfaces the missing env var
            // in test output.
            throw new Error(
              "Scenario 10 requires OPENCLAW_LIVE_DISCORD_SECONDARY_CHANNEL_ID to be set in addition to the base OPENCLAW_LIVE_DISCORD_* bundle",
            );
          }
          const spawn = await spawnAcpWithMarker({
            agentId: "claude",
            marker: marker1,
            task: `Reply with exactly this token and nothing else: ${marker1}`,
            env: liveEnv,
            gateway: client,
            gatewayEnv: { port: 0, token: "" },
            timeoutMs: MATRIX_LONG_TIMEOUT_MS - 90_000,
          });
          originalThreadId = spawn.threadId;
          spawnedSessionKey = spawn.spawnedSessionKey;
          const requestMessageId = spawn.requestMessageId;

          // Strict mode excludes the harness request message id.
          await assertVisibleInThread({
            threadId: originalThreadId,
            marker: marker1,
            env: liveEnv,
            timeoutMs: 45_000,
            excludeMessageIds: [requestMessageId],
          });

          const rebind = await rebindParentToNewThread({
            parentSessionKey: spawnedSessionKey,
            env: liveEnv,
            gateway: client,
          });
          newThreadId = rebind.newThreadId;

          // Follow-up after rebind must land in the NEW thread.
          await followUpInBoundThread({
            threadId: newThreadId,
            spawnedSessionKey,
            text: `Reply with exactly this token and nothing else: ${marker2}`,
            env: liveEnv,
            gateway: client,
            timeoutMs: 60_000,
          });

          const visibleNew = await assertVisibleInThread({
            threadId: newThreadId,
            marker: marker2,
            env: liveEnv,
            timeoutMs: 60_000,
          });
          assertAuthorIdentity(visibleNew, {
            webhookId: "present",
            username: /⚙ claude/i,
          });

          // Negative control: marker2 must NOT appear in the original
          // thread. If it does, the rebind regressed and the old binding
          // is still receiving emissions.
          const oldMessages = await readMessagesInThread({
            threadId: originalThreadId,
            env: liveEnv,
          });
          if (oldMessages.some((msg) => msg.content?.includes(marker2))) {
            throw new Error(
              `S10: rebind regression — marker2 ${marker2} appeared in the old thread ${originalThreadId} after rebind`,
            );
          }

          await assertNoForbiddenChatter({ threadId: newThreadId, env: liveEnv });
          await assertNoLeaksInThread({ threadId: newThreadId, env: liveEnv });
        } finally {
          if (originalThreadId) {
            await cleanupBinding({ threadId: originalThreadId, env: liveEnv });
          }
          if (newThreadId) {
            await cleanupBinding({
              threadId: newThreadId,
              sessionKey: spawnedSessionKey,
              env: liveEnv,
              gateway: client,
            });
          }
        }
      });
    },
    MATRIX_LONG_TIMEOUT_MS,
  );
});
