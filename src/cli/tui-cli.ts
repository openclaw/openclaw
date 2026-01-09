import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { runTui } from "../tui/tui.js";

export function registerTuiCli(program: Command) {
  program
    .command("tui")
    .description("Open a terminal UI connected to the Gateway")
    .option(
      "--url <url>",
      "Gateway WebSocket URL (defaults to gateway.remote.url when configured)",
    )
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (if required)")
    .option(
      "--session <key>",
      'Session key (default: "main", or "global" when scope is global)',
    )
    .option("--deliver", "Deliver assistant replies", false)
    .option("--thinking <level>", "Thinking level override")
    .option("--message <text>", "Send an initial message after connecting")
    .option(
      "--timeout-ms <ms>",
      "Agent timeout in ms (defaults to agents.defaults.timeoutSeconds)",
    )
    .option("--history-limit <n>", "History entries to load", "200")
    .action(async (opts) => {
      try {
        const timeoutMs =
          typeof opts.timeoutMs === "undefined"
            ? undefined
            : Number.parseInt(String(opts.timeoutMs), 10);
        const normalizedTimeoutMs =
          typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
            ? timeoutMs
            : undefined;
        const historyLimit = Number.parseInt(
          String(opts.historyLimit ?? "200"),
          10,
        );
        await runTui({
          url: opts.url as string | undefined,
          token: opts.token as string | undefined,
          password: opts.password as string | undefined,
          session: opts.session as string | undefined,
          deliver: Boolean(opts.deliver),
          thinking: opts.thinking as string | undefined,
          message: opts.message as string | undefined,
          timeoutMs: normalizedTimeoutMs,
          historyLimit: Number.isNaN(historyLimit) ? undefined : historyLimit,
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
