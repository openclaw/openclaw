import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { createTuiLocalCliRunner } from "./tui-local-cli.js";

const PHASES = new Set([
  "inspection_required",
  "preparing",
  "needs_browser_action",
  "waiting_for_connection",
  "ready",
  "blocked",
]);
const CONNECTIONS = new Set(["not_checked", "unavailable", "waiting_for_extension", "connected"]);
const NEXT_ACTIONS: Readonly<Record<string, string>> = {
  none: "Chrome extension connected. Tab availability is checked separately.",
  install: "Run /browser-setup install to install on the TUI process host.",
  open_chrome: "Open Chrome on the TUI process host, then run /browser-setup verify.",
  approve_extension:
    "Approve the extension in Chrome on the TUI process host, then run /browser-setup verify.",
  install_from_store:
    "Install the OpenClaw extension from the Chrome Web Store, then run /browser-setup verify.",
  check_connection: "Run /browser-setup verify to check the local Chrome connection.",
  repair_native_host:
    "Repair the local native host with openclaw browser extension install, then retry.",
  unsupported: "Automatic setup is unavailable on this platform.",
};

/** Project only bounded status fields; never echo CLI diagnostics, paths, or credential-shaped extras. */
function formatSetupResult(value: unknown, action: string): string[] | undefined {
  if (
    !isRecord(value) ||
    value.action !== action ||
    !isRecord(value.target) ||
    value.target.kind !== "local-host" ||
    typeof value.target.profile !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.target.profile) ||
    !isRecord(value.connection) ||
    !isRecord(value.installation) ||
    typeof value.phase !== "string" ||
    !PHASES.has(value.phase) ||
    typeof value.connection.state !== "string" ||
    !CONNECTIONS.has(value.connection.state) ||
    typeof value.nextAction !== "string" ||
    !Object.hasOwn(NEXT_ACTIONS, value.nextAction)
  ) {
    return undefined;
  }
  const installation = value.installation;
  if (
    typeof installation.nativeHostRegistered !== "boolean" ||
    typeof installation.installRequested !== "boolean" ||
    typeof installation.awaitingApproval !== "boolean" ||
    typeof installation.automaticBootstrapSupported !== "boolean" ||
    typeof installation.discoveredProfiles !== "number" ||
    !Number.isSafeInteger(installation.discoveredProfiles) ||
    installation.discoveredProfiles < 0
  ) {
    return undefined;
  }
  return [
    "browser setup: target=TUI process host (not the Gateway), profile=" + value.target.profile,
    "browser setup: action=" +
      action +
      " phase=" +
      value.phase +
      " connection=" +
      value.connection.state,
    "browser setup: nativeHostRegistered=" +
      installation.nativeHostRegistered +
      " installRequested=" +
      installation.installRequested +
      " discoveredProfiles=" +
      installation.discoveredProfiles +
      " awaitingApproval=" +
      installation.awaitingApproval +
      " automaticBootstrapSupported=" +
      installation.automaticBootstrapSupported,
    "browser setup: " + NEXT_ACTIONS[value.nextAction],
  ];
}

export async function runTuiBrowserSetup(params: {
  args: string;
  localCli: Pick<ReturnType<typeof createTuiLocalCliRunner>, "runJson">;
  report: (line: string) => void;
}) {
  const action = params.args.trim() || "inspect";
  if (action !== "inspect" && action !== "install" && action !== "verify") {
    params.report(
      "Usage: /browser-setup [inspect|install|verify] — runs on the TUI process host; no credentials accepted.",
    );
    return;
  }
  params.report(
    "browser setup: " + action + " on the TUI process host (not the Gateway); /stop cancels",
  );
  const result = await params.localCli.runJson([
    "browser",
    "extension",
    "setup",
    "--action",
    action,
    "--json",
    "--wait-ms",
    "1000",
  ]);
  if (!result.ok) {
    params.report("browser setup: " + result.reason + "; retry /browser-setup inspect when ready");
    return;
  }
  const lines = formatSetupResult(result.value, action);
  if (!lines) {
    params.report("browser setup: invalid_response; check the installed OpenClaw CLI version");
    return;
  }
  for (const line of lines) {
    params.report(line);
  }
}
