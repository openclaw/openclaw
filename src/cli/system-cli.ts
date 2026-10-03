import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { danger } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "./failure-output.js";
import type { GatewayRpcOpts } from "./gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";
import { formatDocsHelp } from "./help-format.js";
import { setCommandJsonMode } from "./program/json-mode.js";
import { isSystemMachineOutput } from "./system-output-mode.js";

type SystemEventOpts = GatewayRpcOpts & {
  text?: string;
  mode?: string;
  sessionKey?: string;
  json?: boolean;
};
type SystemGatewayOpts = GatewayRpcOpts & { json?: boolean };

const normalizeWakeMode = (raw: unknown) => {
  const mode = normalizeOptionalString(raw) ?? "";
  if (!mode) {
    return "next-heartbeat" as const;
  }
  if (mode === "now" || mode === "next-heartbeat") {
    return mode;
  }
  throw new Error("--mode must be now or next-heartbeat");
};

async function runSystemGatewayCommand(
  opts: SystemGatewayOpts,
  action: () => Promise<unknown>,
  successText?: string,
): Promise<void> {
  const machineOutput = opts.json || successText === undefined;
  try {
    const result = await action();
    if (machineOutput) {
      defaultRuntime.writeJson(result);
    } else {
      defaultRuntime.log(successText);
    }
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (machineOutput) {
      defaultRuntime.writeJson(formatCliJsonFailure(message));
    } else {
      defaultRuntime.error(danger(message));
    }
    defaultRuntime.exit(1);
  }
}

/** Register Gateway-backed session event and presence commands. */
export function registerSystemCli(program: Command) {
  const system = program
    .command("system")
    .description("System tools (session events, presence)")
    .addHelpText("after", () => formatDocsHelp("/cli/system"));
  setCommandJsonMode(system, "output", ({ argv }) => isSystemMachineOutput(argv));

  addGatewayClientOptions(
    system
      .command("event")
      .description("Submit a session event (use --mode now for immediate processing)")
      .requiredOption("--text <text>", "System event text")
      .option(
        "--mode <mode>",
        "now: process immediately; next-heartbeat: deprecated scheduled-job deferral",
        "next-heartbeat",
      )
      .option(
        "--session-key <sessionKey>",
        "Target a specific session for the event (defaults to the agent's main session)",
      )
      .addHelpText(
        "after",
        "\nPrefer --mode now for new calls. The legacy next-heartbeat mode requires a scheduled target unless --session-key is explicit (immediate). Use openclaw automations for delayed work.\n",
      )
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemEventOpts) => {
    await runSystemGatewayCommand(
      opts,
      async () => {
        const text = normalizeOptionalString(opts.text) ?? "";
        if (!text) {
          throw new Error(
            `--text is required. Example: ${formatCliCommand('openclaw system event --text "deploy finished"')}.`,
          );
        }
        const mode = normalizeWakeMode(opts.mode);
        const sessionKey = normalizeOptionalString(opts.sessionKey);
        const result = await callGatewayFromCli(
          "wake",
          opts,
          sessionKey ? { mode, text, sessionKey } : { mode, text },
          { expectFinal: false },
        );
        if (typeof result === "object" && result !== null && "ok" in result && !result.ok) {
          const reason =
            "reason" in result && typeof result.reason === "string"
              ? result.reason
              : "Gateway did not accept the system event";
          throw new Error(reason);
        }
        return result;
      },
      "ok",
    );
  });

  addGatewayClientOptions(
    system
      .command("presence")
      .description("List system presence entries")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemGatewayOpts) => {
    await runSystemGatewayCommand(opts, () =>
      callGatewayFromCli("system-presence", opts, undefined, { expectFinal: false }),
    );
  });
}
