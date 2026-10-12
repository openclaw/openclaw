import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import { getRuntimeConfig } from "../config/io.js";
import { defaultRuntime } from "../runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import {
  callSessionTargetGateway,
  resolveSessionTarget,
  type SessionTargetGateway,
} from "./session-target.js";

type AttachGrant = {
  sessionKey: string;
  token: string;
  expiresAtMs: number;
  mcpConfig: { mcpServers: Record<string, unknown> };
  env: Record<string, string>;
};

export function writeClaudeMcpConfig(mcpConfig: AttachGrant["mcpConfig"]) {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-attach-"));
  const path = join(dir, ".mcp.json");
  try {
    writeFileSync(path, JSON.stringify(mcpConfig, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function registerAttachCli(program: Command) {
  program
    .command("attach")
    .description("Attach Claude Code to a gateway session with scoped MCP tools")
    .argument("[target]", "Control UI URL, host/agent/ref, short ref, or agent:... key")
    .option("--session <key>", "Gateway session key to bind (default: main session)")
    .option("--url <url>", "Gateway WebSocket URL")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (if required)")
    .option("--tls-fingerprint <sha256>", "Expected Gateway TLS certificate fingerprint")
    .option(
      "--ttl <ms>",
      "Grant TTL in positive base-10 integer milliseconds (default: gateway policy)",
    )
    .option("--bin <path>", "Claude Code binary to spawn", "claude")
    .option(
      "--print-config",
      "Mint the grant + write the .mcp.json, print how to launch it, and exit without spawning",
      false,
    )
    .addHelpText(
      "after",
      "\nExamples:\n  openclaw attach                       Attach Claude Code to the main session\n  openclaw attach movies-a1166b81       Attach to a short session reference\n  openclaw attach --session agent:main:telegram:123 --ttl 600000\n  openclaw attach --print-config        Set up the grant + config and print how to launch it yourself\n",
    )
    .action(
      async (
        target: string | undefined,
        opts: {
          session?: string;
          url?: string;
          token?: string;
          password?: string;
          tlsFingerprint?: string;
          ttl?: string;
          bin: string;
          printConfig: boolean;
        },
      ) => {
        const signal = getAsyncWorkSignal();
        signal?.throwIfAborted();
        if (target && opts.session) {
          throw new Error("pass one session target: use either the positional target or --session");
        }
        let ttlMs: number | undefined;
        if (opts.ttl !== undefined) {
          ttlMs = parseStrictPositiveInteger(opts.ttl);
          if (ttlMs === undefined) {
            defaultRuntime.error(
              `--ttl must be a positive integer of milliseconds. Got: ${JSON.stringify(opts.ttl)}`,
            );
            defaultRuntime.exit(1);
            return;
          }
        }

        const cfg = getRuntimeConfig();
        const requestedGateway: SessionTargetGateway = {
          config: cfg,
          url: opts.url,
          token: opts.token,
          password: opts.password,
          tlsFingerprint: opts.tlsFingerprint,
        };
        const resolved = target
          ? await resolveSessionTarget({ raw: target, gateway: requestedGateway })
          : undefined;
        const gateway = resolved?.gateway ?? requestedGateway;
        signal?.throwIfAborted();
        const granted = (await callSessionTargetGateway({
          gateway,
          method: "attach.grant",
          request: {
            sessionKey: resolved?.sessionKey ?? opts.session,
            ...(resolved ? { agentId: resolved.agentId } : {}),
            ttlMs,
          },
          requiredScope: "operator.admin",
        })) as Partial<AttachGrant> | null;
        if (
          !granted ||
          typeof granted.token !== "string" ||
          typeof granted.sessionKey !== "string" ||
          typeof granted.expiresAtMs !== "number" ||
          !Number.isFinite(granted.expiresAtMs) ||
          !granted.mcpConfig?.mcpServers ||
          typeof granted.env !== "object" ||
          granted.env === null
        ) {
          defaultRuntime.error("attach.grant returned an unexpected response from the gateway.");
          defaultRuntime.exit(1);
          return;
        }
        const grant = granted as AttachGrant;

        let keepGrant = false;
        let cleanupConfig: (() => void) | undefined;
        let detachChild: (() => void) | undefined;
        let expiresAt = String(grant.expiresAtMs);
        let exitCode = 0;
        try {
          // A grant response can arrive after CLI cancellation. Its custody is
          // already ours, so unwind through revocation before creating anything.
          signal?.throwIfAborted();
          expiresAt = new Date(grant.expiresAtMs).toISOString();
          const config = writeClaudeMcpConfig(grant.mcpConfig);
          cleanupConfig = config.cleanup;
          const claudeArgs = ["--strict-mcp-config", "--mcp-config", config.path];

          if (opts.printConfig) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  sessionKey: grant.sessionKey,
                  expiresAt,
                  env: grant.env,
                  configPath: config.path,
                  launch: [opts.bin, ...claudeArgs],
                },
                null,
                2,
              ),
            );
            defaultRuntime.log(
              `Grant is live until ${expiresAt} and auto-expires; it is not revoked here. Launch with the env above, then delete ${config.path} when done.`,
            );
            keepGrant = true;
            return;
          }

          defaultRuntime.log(
            `Attaching Claude Code to session ${grant.sessionKey} (grant expires ${expiresAt})…`,
          );
          signal?.throwIfAborted();
          const child = spawn(opts.bin, claudeArgs, {
            stdio: "inherit",
            env: { ...process.env, ...grant.env },
          });
          let childClosed = false;
          let childError: Error | undefined;
          const onError = (error: Error) => {
            childError ??= error;
          };
          // The child shares the foreground terminal group and receives Ctrl+C
          // itself. Keep the parent alive to revoke its grant, without sending twice.
          const onSigint = () => {};
          const onSigterm = () => {
            if (!childClosed) {
              child.kill("SIGTERM");
            }
          };
          child.on("error", onError);
          process.on("SIGINT", onSigint);
          process.on("SIGTERM", onSigterm);
          detachChild = () => {
            child.off("error", onError);
            process.off("SIGINT", onSigint);
            process.off("SIGTERM", onSigterm);
          };
          // Node emits close after exit or spawn error and after owned stdio closes.
          const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve) => {
              child.once("close", (code, exitSignal) => {
                childClosed = true;
                resolve({ code, signal: exitSignal });
              });
            },
          );
          if (childError) {
            defaultRuntime.error(`Failed to launch '${opts.bin}': ${String(childError)}`);
            exitCode = 1;
          } else {
            exitCode = outcome.signal
              ? 128 + ((osConstants.signals as Record<string, number>)[outcome.signal] ?? 0)
              : (outcome.code ?? 0);
          }
        } finally {
          try {
            if (!keepGrant) {
              try {
                await callSessionTargetGateway({
                  gateway,
                  method: "attach.revoke",
                  request: { token: grant.token },
                  requiredScope: "operator.admin",
                });
              } catch (error) {
                defaultRuntime.error(
                  `Warning: failed to revoke attach grant; it remains live until ${expiresAt}. ${String(error)}`,
                );
              } finally {
                cleanupConfig?.();
              }
            }
          } finally {
            detachChild?.();
          }
        }
        defaultRuntime.exit(exitCode);
      },
    );
}
