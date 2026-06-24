// `openclaw attach` — launch Claude Code bound to a gateway session with scoped MCP tools. Mints a
// per-session attach grant (attach.grant), writes the returned loopback MCP config to a temp
// `.mcp.json` for `claude --mcp-config`, spawns Claude Code interactively, and revokes the grant on
// exit. The grant — not a process-global token — keeps this a lower-trust, revocable boundary
// (see src/gateway/mcp-grant-store.ts).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { getRuntimeConfig } from "../config/io.js";
import { callGateway } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";

/** What attach.grant returns (gateway method in src/gateway/server-methods/attach.ts). */
type AttachGrant = {
  sessionKey: string;
  token: string;
  expiresAtMs: number;
  mcpConfig: { mcpServers: Record<string, unknown> };
  env: Record<string, string>;
};

/**
 * Write the gateway's mcpConfig verbatim to a temp `.mcp.json` for `claude --mcp-config`. The entry
 * keeps the gateway's `${OPENCLAW_MCP_*}` header placeholders, which Claude Code substitutes from
 * the process env — so the bearer token never lands in argv or a durable file. Returns the path and
 * a cleanup() for the temp dir.
 */
export function writeClaudeMcpConfig(mcpConfig: AttachGrant["mcpConfig"]): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-attach-"));
  const path = join(dir, ".mcp.json");
  writeFileSync(path, JSON.stringify(mcpConfig, null, 2), { encoding: "utf8", mode: 0o600 });
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function registerAttachCli(program: Command, _argv: string[] = process.argv) {
  program
    .command("attach")
    .description("Attach Claude Code to a gateway session with scoped MCP tools")
    .option("--session <key>", "Gateway session key to bind (default: main session)")
    .option("--ttl <ms>", "Grant TTL in milliseconds (default: gateway policy)")
    .option("--bin <path>", "Claude Code binary to spawn", "claude")
    .option(
      "--print-config",
      "Mint the grant + write the .mcp.json, print how to launch it, and exit without spawning",
      false,
    )
    .addHelpText(
      "after",
      "\nExamples:\n  openclaw attach                       Attach Claude Code to the main session\n  openclaw attach --session agent:main:telegram:123 --ttl 600000\n  openclaw attach --print-config        Set up the grant + config and print how to launch it yourself\n",
    )
    .action(async (opts: { session?: string; ttl?: string; bin: string; printConfig: boolean }) => {
      let ttlMs: number | undefined;
      if (opts.ttl !== undefined) {
        // A provided --ttl must be a positive number; empty/non-numeric values error rather than
        // silently falling back to the gateway default.
        ttlMs = Number(opts.ttl);
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
          defaultRuntime.error(
            `--ttl must be a positive number of milliseconds. Got: ${JSON.stringify(opts.ttl)}`,
          );
          defaultRuntime.exit(1);
          return;
        }
      }

      const cfg = getRuntimeConfig();
      const granted = (await callGateway({
        config: cfg,
        method: "attach.grant",
        params: { sessionKey: opts.session, ttlMs },
        // attach.grant is operator.admin-scoped. Use CLI mode so callGateway auto-resolves the
        // operator device identity (which carries operator.admin); mode BACKEND or an explicit
        // deviceIdentity:null drops it and the call fails with "missing scope: operator.admin".
        mode: GATEWAY_CLIENT_MODES.CLI,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
      })) as Partial<AttachGrant> | null;
      // Validate the RPC boundary rather than trusting the cast — a malformed/error response must
      // fail loudly here, not crash later when writing the config.
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

      const { path: configPath, cleanup } = writeClaudeMcpConfig(grant.mcpConfig);
      const expiresAt = new Date(grant.expiresAtMs).toISOString();

      // --print-config is a setup mode: leave the grant live (TTL-bounded) and the config file in
      // place so the user can launch Claude Code themselves; do NOT revoke or delete here. The grant
      // auto-expires at its TTL (there is no separate revoke CLI command).
      if (opts.printConfig) {
        defaultRuntime.log(
          JSON.stringify(
            {
              sessionKey: grant.sessionKey,
              expiresAt,
              env: grant.env,
              configPath,
              launch: [opts.bin, "--mcp-config", configPath],
            },
            null,
            2,
          ),
        );
        defaultRuntime.log(
          `Grant is live until ${expiresAt} and auto-expires; it is not revoked here. Launch with the env above, then delete ${configPath} when done.`,
        );
        return;
      }

      // Single revoke+cleanup shared by all terminal paths (error/exit can race; the promise dedupes).
      let revokePromise: Promise<void> | undefined;
      const revokeOnce = () =>
        (revokePromise ??= (async () => {
          try {
            await callGateway({
              config: cfg,
              method: "attach.revoke",
              params: { token: grant.token },
              // operator.admin-scoped like attach.grant — see the mode note there.
              mode: GATEWAY_CLIENT_MODES.CLI,
              clientName: GATEWAY_CLIENT_NAMES.CLI,
            });
          } catch {
            // Best-effort: the grant's TTL still bounds it if revoke can't reach the gateway.
          }
          cleanup();
        })());

      defaultRuntime.log(
        `Attaching Claude Code to session ${grant.sessionKey} (grant expires ${expiresAt})…`,
      );
      const child = spawn(opts.bin, ["--mcp-config", configPath], {
        stdio: "inherit",
        env: { ...process.env, ...grant.env },
      });

      // Claude Code shares the TTY foreground group, so Ctrl-C reaches it directly — don't forward
      // SIGINT (that double-delivers). Keep the parent alive (no-op) so its exit handler can revoke.
      // SIGTERM is not TTY-delivered to the child, so forward it explicitly.
      const onSigint = () => {};
      const onSigterm = () => child.kill("SIGTERM");
      // Detach the process-global handlers once the child is done so repeated invocations (and tests)
      // don't accumulate listeners or leave a stale handler bound to an exited child.
      const finish = (code: number) => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        defaultRuntime.exit(code);
      };

      child.on("error", (error) => {
        void (async () => {
          defaultRuntime.error(`Failed to launch '${opts.bin}': ${String(error)}`);
          await revokeOnce();
          finish(1);
        })();
      });
      child.on("exit", (code, signal) => {
        void (async () => {
          await revokeOnce();
          // Mirror the child's termination: 128+signal on signal death, else its exit code.
          const signalCode = signal
            ? 128 + ((osConstants.signals as Record<string, number>)[signal] ?? 0)
            : null;
          finish(signalCode ?? code ?? 0);
        })();
      });
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
    });
}
