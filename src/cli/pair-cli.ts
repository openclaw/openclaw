import type { Command } from "commander";
import type {
  DevicePairCodeParams,
  DevicePairCodeResult,
} from "../../packages/gateway-protocol/src/index.js";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { defaultRuntime } from "../runtime.js";
import {
  formatBrowserPairCode,
  formatBrowserPairDeviceId,
  normalizeBrowserPairCode,
} from "../shared/browser-pair.js";
import { throwExpectedCliError } from "./expected-cli-error.js";
import { addGatewayClientOptions, callGatewayFromCliWithTransport } from "./gateway-rpc.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { formatDocsHelp } from "./help-format.js";
import { promptYesNo } from "./prompt.js";

type PairOpts = GatewayRpcOpts & { yes?: boolean; json?: boolean };

const PAIR_DEFAULT_TIMEOUT_MS = 10_000;

async function callPairCode(opts: PairOpts, params: DevicePairCodeParams) {
  try {
    return await callGatewayFromCliWithTransport<DevicePairCodeResult>(
      "device.pair.code",
      opts,
      params,
      {
        label: "Pair device.pair.code",
        defaultTimeoutMs: PAIR_DEFAULT_TIMEOUT_MS,
        scopes: [ADMIN_SCOPE],
        sharedStateMode: "read-only",
      },
    );
  } catch (error) {
    return throwExpectedCliError(error instanceof Error ? error.message : String(error));
  }
}

function formatMinutesAgo(atMs: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - atMs) / 60_000));
  if (minutes === 0) {
    return "just now";
  }
  return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
}

function logRequest(request: DevicePairCodeResult): void {
  const rows: [string, string | undefined][] = [
    ["Code", formatBrowserPairCode(request.code)],
    ["Browser (reported)", request.userAgent],
    ["Address", request.remoteIp],
    ["Page (reported)", request.origin],
    ["Browser ID", formatBrowserPairDeviceId(request.deviceId)],
    ["Requested", formatMinutesAgo(request.createdAtMs)],
  ];
  defaultRuntime.log("A browser is asking to pair with administrator access to this Gateway.");
  defaultRuntime.log("");
  for (const [label, value] of rows) {
    if (value) {
      defaultRuntime.log(terminalText`  ${label.padEnd(18)} ${value}`);
    }
  }
  defaultRuntime.log("");
  defaultRuntime.log(
    "Approve only if you opened this page yourself and it shows this code and Browser ID.",
  );
  defaultRuntime.log(
    "If someone sent you this code or command, answer no: approving gives their browser administrator control of this Gateway.",
  );
}

export async function runPairCommand(rawCode: string, opts: PairOpts): Promise<void> {
  const code = normalizeBrowserPairCode(rawCode);
  if (!code) {
    throwExpectedCliError(
      "That is not a pairing code. Copy the code shown in the browser, for example ABCD-EFGH.",
    );
  }
  const request = await callPairCode(opts, { code });
  if (!opts.json) {
    logRequest(request);
  }
  if (!opts.yes && (opts.json || !process.stdin.isTTY)) {
    throwExpectedCliError(
      "Nothing was approved because this run cannot answer a prompt. Use `ssh -t`, or rerun with --yes after checking the request details.",
    );
  }
  const { requestId } = request;
  if (!opts.yes && !(await promptYesNo("Approve this browser?", false))) {
    await callPairCode(opts, { code, requestId, decision: "reject" });
    defaultRuntime.log("Declined. The browser was told it was not approved.");
    return;
  }
  const approved = await callPairCode(opts, { code, requestId, decision: "approve" });
  if (opts.json) {
    defaultRuntime.writeJson({ approved: true, deviceId: approved.deviceId });
    return;
  }
  defaultRuntime.log("Approved. The waiting browser connects by itself.");
  defaultRuntime.log(
    `It is listed in \`openclaw devices list\`; remove it with \`openclaw devices remove ${approved.deviceId}\` to end its access.`,
  );
}

export function registerPairCli(program: Command) {
  const pair = program
    .command("pair")
    .description("Approve a browser showing a pairing code")
    .argument("<code>", "Code shown in the browser, for example ABCD-EFGH")
    .option("--yes", "Approve without asking; details are still printed", false)
    .option("--json", "Output JSON (requires --yes)", false)
    .addHelpText("after", () => formatDocsHelp("/cli/pair"))
    .action(async (code: string, opts: PairOpts) => {
      await runPairCommand(code, opts);
    });
  addGatewayClientOptions(pair, { timeoutMs: PAIR_DEFAULT_TIMEOUT_MS });
}
