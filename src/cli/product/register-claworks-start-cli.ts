import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { CLAWORKS_STANDARD_GATEWAY_PORT } from "../../config/claworks-gateway.js";
import { isClaworksProduct } from "../../config/paths.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatCliCommand } from "../command-format.js";
import { parsePort } from "../shared/parse-port.js";
import { ensureClaworksProductReady, printClaworksStartupBanner } from "./claworks-bootstrap.js";

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function runGatewayAfterBootstrap(opts: {
  port?: number;
  bind?: string;
  force?: boolean;
  verbose?: boolean;
  watch?: boolean;
}): Promise<void> {
  const port = opts.port ?? CLAWORKS_STANDARD_GATEWAY_PORT;
  const bind = opts.bind ?? "loopback";
  const gatewayArgs = [
    "gateway",
    "run",
    "--port",
    String(port),
    "--bind",
    bind,
    ...(opts.force ? ["--force"] : []),
    ...(opts.verbose ? ["--verbose"] : []),
  ];

  if (opts.watch) {
    const watchScript = path.join(repoRoot(), "scripts/watch-node.mjs");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [watchScript, ...gatewayArgs, "--force"], {
        cwd: repoRoot(),
        env: process.env,
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`gateway watch exited with code ${code}`));
        }
      });
    });
    return;
  }

  const { resolveGatewayRunOptions, runGatewayCommand } = await import("../gateway-cli/run.js");
  await runGatewayCommand(
    resolveGatewayRunOptions({
      port: String(port),
      bind,
      force: opts.force,
      verbose: opts.verbose,
    }),
  );
}

async function runOnboardWizard(): Promise<void> {
  const { setupWizardCommand } = await import("../../commands/onboard.js");
  await setupWizardCommand({ mode: "local" }, defaultRuntime);
}

function registerStartAction(cmd: Command): void {
  cmd
    .option("--port <port>", `Gateway port (default ${CLAWORKS_STANDARD_GATEWAY_PORT})`)
    .option("--bind <mode>", "Bind mode (loopback|lan|…)", "loopback")
    .option("--force", "Free the target port before start", false)
    .option("--verbose", "Verbose gateway logs", false)
    .option("--watch", "Restart gateway on file changes (dev)", false)
    .option("--setup", "Run interactive onboard before starting (first-time)", false)
    .option("--no-repair", "Skip config repair", false)
    .option("--no-init", "Do not auto-create config if missing", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const log = (line: string) => defaultRuntime.log(line);
        const portParsed = parsePort(opts.port);
        if (opts.port !== undefined && portParsed === null) {
          defaultRuntime.error("Invalid --port");
          defaultRuntime.exit(1);
          return;
        }

        const bootstrap = ensureClaworksProductReady({
          initIfMissing: opts.init !== false,
          repair: opts.repair !== false,
          log: (line) => log(theme.muted(line)),
        });

        if (opts.setup || (bootstrap.created && !process.env.CLAWORKS_SKIP_ONBOARD)) {
          log(theme.heading("First-time setup"));
          log(theme.muted("Running onboard wizard (gateway, model, channels)…"));
          await runOnboardWizard();
        }

        printClaworksStartupBanner(bootstrap, log);

        await runGatewayAfterBootstrap({
          port: portParsed ?? bootstrap.port,
          bind: String(opts.bind ?? "loopback"),
          force: Boolean(opts.force),
          verbose: Boolean(opts.verbose),
          watch: Boolean(opts.watch),
        });
      });
    });
}

/** Product-only: `claworks start` — bootstrap + gateway (OpenClaw-style one command). */
export async function registerClaworksStartCliIfProduct(program: Command): Promise<void> {
  if (!isClaworksProduct()) {
    return;
  }

  const start = program
    .command("start")
    .description("Bootstrap config and run the ClaWorks Gateway (init/repair + gateway run)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n` +
        `  ${theme.command("claworks start")}\n` +
        `    ${theme.muted("Repair config, then run Gateway on :18800.")}\n` +
        `  ${theme.command("claworks start --setup")}\n` +
        `    ${theme.muted("First run: onboard wizard, then Gateway.")}\n` +
        `  ${theme.command("claworks start --watch")}\n` +
        `    ${theme.muted("Dev mode with auto-restart on source changes.")}\n\n` +
        `Equivalent: ${theme.command(formatCliCommand("claworks gateway run --port 18800"))}\n`,
    );
  registerStartAction(start);

  const up = program.command("up").description("Alias for claworks start");
  registerStartAction(up);
}
