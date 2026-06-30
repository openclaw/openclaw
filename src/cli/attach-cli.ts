// `openclaw attach` — launch Claude Code bound to a gateway session with scoped MCP tools. Two
// transports, auto-detected: on the gateway host it mints a grant (attach.grant) and points claude
// at the loopback MCP; on a node it goes through the conduit (node-cli/attach.runNodeAttach) over the
// node's existing gateway link. Either way the grant — not a process-global token — keeps this a
// lower-trust, revocable boundary (see src/gateway/mcp-grant-store.ts). The config is written to a
// temp `.mcp.json` for `claude --mcp-config`; the grant/forwarder is torn down on exit.
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
// runNodeAttach is lazy-imported on the node path only — it pulls the node-host runtime, which must
// not load (or slow startup) for the common gateway-host attach.

/** What attach.grant returns (gateway method in src/gateway/server-methods/attach.ts). */
type AttachGrant = {
  sessionKey: string;
  token: string;
  expiresAtMs: number;
  mcpConfig: { mcpServers: Record<string, unknown> };
  env: Record<string, string>;
};

/** Transport-agnostic launch plan: what the spawn step needs, plus a path-specific teardown. */
type AttachLaunchPlan = {
  sessionKey: string;
  mcpConfig: { mcpServers: Record<string, unknown> };
  env: Record<string, string>;
  /** Extra claude argv (the node conduit hydrates a session → `--resume <id>`); empty for loopback. */
  launchArgs: string[];
  /** ISO expiry for logging, when the transport exposes one (the grant TTL). */
  expiresAt?: string;
  /** Revoke the grant / tear down the forwarder + node link. Does NOT remove the temp config dir. */
  close: () => Promise<void>;
};

/**
 * Write the gateway's mcpConfig verbatim to a temp `.mcp.json` for `claude --mcp-config`. The entry
 * keeps the gateway's `${OPENCLAW_MCP_*}` header placeholders, which Claude Code substitutes from
 * the process env — so the bearer token never lands in argv or a durable file. Returns the path and
 * a cleanup() for the temp dir.
 */
export function writeClaudeMcpConfig(mcpConfig: AttachLaunchPlan["mcpConfig"]): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-attach-"));
  const path = join(dir, ".mcp.json");
  writeFileSync(path, JSON.stringify(mcpConfig, null, 2), { encoding: "utf8", mode: 0o600 });
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Gateway-host transport: mint the grant via attach.grant and point claude at the loopback MCP. */
async function acquireGatewayHostPlan(
  cfg: ReturnType<typeof getRuntimeConfig>,
  opts: { session?: string; ttlMs?: number },
): Promise<AttachLaunchPlan> {
  const granted = (await callGateway({
    config: cfg,
    method: "attach.grant",
    params: { sessionKey: opts.session, ttlMs: opts.ttlMs },
    // attach.grant is operator.admin-scoped. CLI mode lets callGateway auto-resolve the operator
    // device identity (which carries operator.admin); BACKEND/null drops it -> "missing scope".
    mode: GATEWAY_CLIENT_MODES.CLI,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
  })) as Partial<AttachGrant> | null;
  // Validate the RPC boundary rather than trusting the cast — a malformed/error response fails here.
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
    throw new Error("attach.grant returned an unexpected response from the gateway.");
  }
  const grant = granted as AttachGrant;
  let revokePromise: Promise<void> | undefined;
  return {
    sessionKey: grant.sessionKey,
    mcpConfig: grant.mcpConfig,
    env: grant.env,
    launchArgs: [],
    expiresAt: new Date(grant.expiresAtMs).toISOString(),
    close: () =>
      (revokePromise ??= (async () => {
        try {
          await callGateway({
            config: cfg,
            method: "attach.revoke",
            params: { token: grant.token },
            mode: GATEWAY_CLIENT_MODES.CLI,
            clientName: GATEWAY_CLIENT_NAMES.CLI,
          });
        } catch {
          // Best-effort: the grant's TTL still bounds it if revoke can't reach the gateway.
        }
      })()),
  };
}

export async function registerAttachCli(program: Command, _argv: string[] = process.argv) {
  program
    .command("attach")
    .description("Attach Claude Code to a gateway session with scoped MCP tools")
    .option("--session <key>", "Gateway session key to bind (default: main session)")
    .option("--ttl <ms>", "Grant TTL in milliseconds (default: gateway policy)")
    .option("--bin <path>", "Claude Code binary to spawn", "claude")
    .option(
      "--via <mode>",
      "Transport: auto (default; gateway host, else node conduit), gateway, or node",
      "auto",
    )
    .option(
      "--print-config",
      "Mint the grant + write the .mcp.json, print how to launch it, and exit without spawning (gateway transport only)",
      false,
    )
    .addHelpText(
      "after",
      "\nExamples:\n  openclaw attach                       Attach Claude Code to the main session\n  openclaw attach --session agent:main:telegram:123 --ttl 600000\n  openclaw attach --via node            Force the node conduit (run on a paired node)\n  openclaw attach --print-config        Set up the grant + config and print how to launch it yourself\n",
    )
    .action(
      async (opts: {
        session?: string;
        ttl?: string;
        bin: string;
        via: string;
        printConfig: boolean;
      }) => {
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
        const via = opts.via ?? "auto";
        if (via !== "auto" && via !== "gateway" && via !== "node") {
          defaultRuntime.error(
            `--via must be one of: auto, gateway, node. Got: ${JSON.stringify(via)}`,
          );
          defaultRuntime.exit(1);
          return;
        }

        const cfg = getRuntimeConfig();
        let plan: AttachLaunchPlan | undefined;
        const failures: string[] = [];

        if (via === "gateway" || via === "auto") {
          try {
            plan = await acquireGatewayHostPlan(cfg, { session: opts.session, ttlMs });
          } catch (error) {
            failures.push(`gateway: ${error instanceof Error ? error.message : String(error)}`);
            if (via === "gateway") {
              defaultRuntime.error(failures[failures.length - 1] ?? "gateway transport failed");
              defaultRuntime.exit(1);
              return;
            }
          }
        }

        if (!plan && (via === "node" || via === "auto")) {
          // The node conduit's forwarder is in-process, so it can't outlive a --print-config run.
          if (opts.printConfig) {
            defaultRuntime.error(
              "--print-config is not supported for the node conduit (the loopback forwarder is in-process). Use --via gateway, or run without --print-config.",
            );
            defaultRuntime.exit(1);
            return;
          }
          try {
            const { runNodeAttach } = await import("./node-cli/attach.js");
            plan = await runNodeAttach({ cwd: process.cwd(), nowMs: Date.now() });
          } catch (error) {
            failures.push(`node: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        if (!plan) {
          defaultRuntime.error(
            `Could not attach. ${failures.join("; ") || "no transport available."}`,
          );
          defaultRuntime.exit(1);
          return;
        }

        const { path: configPath, cleanup } = writeClaudeMcpConfig(plan.mcpConfig);
        const expiryNote = plan.expiresAt ? ` (grant expires ${plan.expiresAt})` : "";

        // --print-config is a setup mode (gateway transport only): leave the grant live (TTL-bounded)
        // and the config in place so the user can launch Claude Code themselves; do NOT revoke/delete.
        if (opts.printConfig) {
          defaultRuntime.log(
            JSON.stringify(
              {
                sessionKey: plan.sessionKey,
                expiresAt: plan.expiresAt,
                env: plan.env,
                configPath,
                launch: [opts.bin, "--mcp-config", configPath, ...plan.launchArgs],
              },
              null,
              2,
            ),
          );
          defaultRuntime.log(
            `Grant is live${expiryNote} and auto-expires; it is not revoked here. Launch with the env above, then delete ${configPath} when done.`,
          );
          return;
        }

        // Single teardown shared by all terminal paths (error/exit can race; the promise dedupes).
        let closePromise: Promise<void> | undefined;
        const closeOnce = () =>
          (closePromise ??= (async () => {
            await plan.close();
            cleanup();
          })());

        defaultRuntime.log(`Attaching Claude Code to session ${plan.sessionKey}${expiryNote}…`);
        const child = spawn(opts.bin, ["--mcp-config", configPath, ...plan.launchArgs], {
          stdio: "inherit",
          env: { ...process.env, ...plan.env },
        });

        // Claude Code shares the TTY foreground group, so Ctrl-C reaches it directly — don't forward
        // SIGINT (that double-delivers). Keep the parent alive (no-op) so its exit handler can clean up.
        // SIGTERM is not TTY-delivered to the child, so forward it explicitly.
        const onSigint = () => {};
        const onSigterm = () => child.kill("SIGTERM");
        const finish = (code: number) => {
          process.off("SIGINT", onSigint);
          process.off("SIGTERM", onSigterm);
          defaultRuntime.exit(code);
        };

        child.on("error", (error) => {
          void (async () => {
            defaultRuntime.error(`Failed to launch '${opts.bin}': ${String(error)}`);
            await closeOnce();
            finish(1);
          })();
        });
        child.on("exit", (code, signal) => {
          void (async () => {
            await closeOnce();
            // Mirror the child's termination: 128+signal on signal death, else its exit code.
            const signalCode = signal
              ? 128 + ((osConstants.signals as Record<string, number>)[signal] ?? 0)
              : null;
            finish(signalCode ?? code ?? 0);
          })();
        });
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
      },
    );
}
