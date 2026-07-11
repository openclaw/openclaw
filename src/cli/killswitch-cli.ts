// Commander registration for the operator killswitch: pause/resume agent
// runs gateway-wide over the gateway's own RPC control plane, for direct or
// SSH-based operator use (the layered hard-stop counterpart to
// `openclaw daemon service stop` and to the Signal killswitch fast-path).
import type { Command } from "commander";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { callGatewayCli } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";

type KillswitchCliOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
  reason?: string;
};

type KillswitchStatusResult = {
  engaged: boolean;
  reason?: string;
  source?: string;
  engagedAtMs?: number;
  releasedAtMs?: number;
};

const DEFAULT_KILLSWITCH_TIMEOUT_MS = 10_000;

function killswitchCallOpts(opts: KillswitchCliOpts) {
  return {
    ...(opts.url ? { url: opts.url } : {}),
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.password ? { password: opts.password } : {}),
    timeoutMs: opts.timeout ? Number(opts.timeout) : DEFAULT_KILLSWITCH_TIMEOUT_MS,
  };
}

function printStatus(status: KillswitchStatusResult, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (!status.engaged) {
    console.log(theme.success("Killswitch is not engaged. Agent runs are proceeding normally."));
    return;
  }
  const when = status.engagedAtMs ? new Date(status.engagedAtMs).toISOString() : "unknown time";
  console.log(
    theme.warn(`⚠️ Killswitch is ENGAGED (since ${when}, source: ${status.source ?? "unknown"}).`),
  );
  if (status.reason) {
    console.log(`  reason: ${status.reason}`);
  }
  console.log("  agent runs are paused. Run `openclaw killswitch disable` to resume.");
}

export function registerKillswitchCli(program: Command): void {
  const killswitch = program
    .command("killswitch")
    .description("Pause or resume agent runs gateway-wide (operator emergency stop)");

  const attachCallOpts = (cmd: Command) =>
    cmd
      .option(
        "--url <url>",
        "Gateway WebSocket URL (defaults to gateway.remote.url when configured)",
      )
      .option("--token <token>", "Gateway token (if required)")
      .option("--password <password>", "Gateway password (password auth)")
      .option("--timeout <ms>", "Timeout in ms", String(DEFAULT_KILLSWITCH_TIMEOUT_MS))
      .option("--json", "Output JSON", false);

  attachCallOpts(killswitch.command("status").description("Show current killswitch state")).action(
    async (opts: KillswitchCliOpts) => {
      const status = await callGatewayCli<KillswitchStatusResult>({
        method: "killswitch.status",
        ...killswitchCallOpts(opts),
      });
      printStatus(status, opts.json);
    },
  );

  attachCallOpts(
    killswitch
      .command("enable")
      .description("Pause agent runs: refuse new runs and abort in-flight ones")
      .option("--reason <text>", "Operator-visible reason recorded with the killswitch state"),
  ).action(async (opts: KillswitchCliOpts) => {
    const status = await callGatewayCli<KillswitchStatusResult & { abortedRunCount?: number }>({
      method: "killswitch.enable",
      params: opts.reason ? { reason: opts.reason } : undefined,
      scopes: [ADMIN_SCOPE],
      ...killswitchCallOpts(opts),
    });
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(
      theme.warn(`⚠️ Killswitch engaged. Aborted ${status.abortedRunCount ?? 0} in-flight run(s).`),
    );
  });

  attachCallOpts(
    killswitch.command("disable").description("Resume agent runs after a killswitch pause"),
  ).action(async (opts: KillswitchCliOpts) => {
    const status = await callGatewayCli<KillswitchStatusResult>({
      method: "killswitch.disable",
      scopes: [ADMIN_SCOPE],
      ...killswitchCallOpts(opts),
    });
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(theme.success("✅ Killswitch released. Agent runs are resuming normally."));
  });
}
