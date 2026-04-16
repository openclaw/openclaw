import { spawn } from "node:child_process";
import type { Command } from "commander";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { formatHelpExamples } from "./help-format.js";

const EXAMPLES = [
  ["openclaw clawmodeler init --workspace ./demo", "Create a workspace template."],
  [
    "openclaw clawmodeler scaffold question --path ./question.json --title 'My study area'",
    "Write a starter question.json you can edit.",
  ],
  ["openclaw clawmodeler doctor", "Check local modeling runtimes."],
  ["openclaw clawmodeler demo --workspace ./demo", "Create and run a complete demo workspace."],
  [
    "openclaw clawmodeler intake --workspace ./demo --inputs zones.geojson socio.csv",
    "Stage and validate inputs.",
  ],
  [
    "openclaw clawmodeler plan --workspace ./demo --question question.json",
    "Create analysis and engine-selection plans.",
  ],
  [
    "openclaw clawmodeler run --workspace ./demo --run-id demo --scenarios baseline build",
    "Run the local modeling stack.",
  ],
  [
    "openclaw clawmodeler export --workspace ./demo --run-id demo --format md",
    "Export a QA-gated report.",
  ],
  [
    "openclaw clawmodeler workflow full --workspace ./demo --inputs zones.geojson socio.csv --question question.json --run-id demo",
    "Run the full modeling workflow.",
  ],
  [
    "openclaw clawmodeler workflow demo-full --workspace ./demo --run-id demo",
    "Run the full demo workflow.",
  ],
  [
    "openclaw clawmodeler workflow report-only --workspace ./demo --run-id demo",
    "Regenerate an existing run report.",
  ],
  ["openclaw clawmodeler workflow diagnose --workspace ./demo", "Diagnose workspace readiness."],
  [
    "openclaw clawmodeler bridge sumo prepare --workspace ./demo --run-id demo",
    "Generate a SUMO bridge package.",
  ],
  [
    "openclaw clawmodeler bridge sumo validate --workspace ./demo --run-id demo",
    "Validate a SUMO bridge package.",
  ],
  [
    "openclaw clawmodeler bridge matsim prepare --workspace ./demo --run-id demo",
    "Generate a MATSim bridge package.",
  ],
  [
    "openclaw clawmodeler bridge urbansim prepare --workspace ./demo --run-id demo",
    "Generate an UrbanSim bridge package.",
  ],
  [
    "openclaw clawmodeler bridge prepare-all --workspace ./demo --run-id demo",
    "Prepare every applicable bridge package.",
  ],
  [
    "openclaw clawmodeler bridge validate --workspace ./demo --run-id demo",
    "Validate all prepared bridge packages.",
  ],
  [
    "openclaw clawmodeler graph map-zones --workspace ./demo",
    "Map staged zones to cached GraphML nodes.",
  ],
] as const;

export function buildClawModelerEngineArgs(args: readonly string[]): string[] {
  return ["-m", "clawmodeler_engine", ...args];
}

export async function runClawModelerEngine(args: readonly string[]): Promise<void> {
  const child = spawn("python3", buildClawModelerEngineArgs(args), {
    stdio: "inherit",
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`clawmodeler-engine exited via signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    process.exitCode = exitCode;
    throw new Error(`clawmodeler-engine exited with code ${exitCode}`);
  }
}

export function registerClawModelerCli(program: Command) {
  program
    .command("clawmodeler")
    .description("Run ClawModeler transportation modeling workflows")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument("[args...]", "Arguments passed to clawmodeler-engine")
    .addHelpText(
      "before",
      () =>
        `${theme.muted(
          "All arguments are forwarded verbatim to the clawmodeler-engine Python sidecar; " +
            "unknown options and typos will surface as sidecar errors.",
        )}\n`,
    )
    .addHelpText(
      "after",
      () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(EXAMPLES)}\n`,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/clawmodeler-stack",
          "docs.openclaw.ai/clawmodeler-stack",
        )}\n`,
    )
    .action(async (args: string[]) => {
      await runClawModelerEngine(args.length > 0 ? args : ["--help"]);
    });
}
