import type { Command } from "commander";

export function addTuiOptions(command: Command): Command {
  return command
    .option(
      "--device-auth",
      "Use the explicitly enrolled interactive operator identity without shared-owner fallback",
      false,
    )
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (if required)")
    .option("--tls-fingerprint <sha256>", "Expected Gateway TLS certificate fingerprint");
}
