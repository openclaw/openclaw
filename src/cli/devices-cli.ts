// Commander registration for device pairing and auth-token commands.
import { Option, type Command } from "commander";
import { createLazyRuntimeMethodBinder } from "../shared/lazy-runtime.js";
import { isDevicesMachineOutput } from "./devices-output-mode.js";
import { setCommandJsonMode } from "./program/json-mode.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

const DEFAULT_DEVICES_TIMEOUT_MS = 10_000;

// Keep device-pairing crypto/table dependencies out of root help startup.
const deviceAction = createLazyRuntimeMethodBinder(() => import("./devices-cli.runtime.js"));
const joinAction = createLazyRuntimeMethodBinder(() => import("./devices-cli-join.js"));

export function registerDevicesCli(program: Command) {
  const devices = program
    .command("devices")
    .description(
      "Device pairing and auth tokens (for mobile app setup codes, use `openclaw qr` instead)",
    );

  devices
    .command("list")
    .description("List pending and paired devices")
    .action(deviceAction((runtime) => runtime.runDevicesListCommand));

  devices
    .command("join-code")
    .description(
      "Mint a single-use node onboarding URL (not a mobile app setup code; use `openclaw qr` for that)",
    )
    .action(joinAction((runtime) => runtime.runDevicesJoinCodeCommand));

  devices
    .command("remove")
    .description("Remove a paired device entry")
    .argument("<deviceId>", "Paired device id")
    .action(deviceAction((runtime) => runtime.runDevicesDeleteCommand.bind(null, "remove")));

  devices
    .command("clear")
    .description("Clear paired devices from the gateway table")
    .option("--pending", "Also reject all pending pairing requests", false)
    .option("--yes", "Confirm destructive clear", false)
    .action(deviceAction((runtime) => runtime.runDevicesClearCommand));

  devices
    .command("approve")
    .description("Approve a pending device pairing request")
    .argument("[requestId]", "Pending request id")
    .option("--latest", "Show the most recent pending request to approve explicitly", false)
    .action(deviceAction((runtime) => runtime.runDevicesApproveCommand));

  devices
    .command("reject")
    .description("Reject a pending device pairing request")
    .argument("<requestId>", "Pending request id")
    .action(deviceAction((runtime) => runtime.runDevicesDeleteCommand.bind(null, "reject")));

  devices
    .command("rename")
    .description("Assign an operator label to a paired device")
    .requiredOption("--device <id>", "Device id")
    .requiredOption("--name <label>", "Operator-assigned label (max 64 characters)")
    .action(deviceAction((runtime) => runtime.runDevicesRenameCommand));

  devices
    .command("rotate")
    .description("Rotate a device token for a role")
    .requiredOption("--device <id>", "Device id")
    .requiredOption("--role <role>", "Role name")
    .option("--scope <scope...>", "Scopes to attach to the token (repeatable)")
    .addOption(new Option("--no-scopes", "Rotate with an empty scope set").conflicts("scope"))
    .action(deviceAction((runtime) => runtime.runDevicesTokenCommand.bind(null, "rotate")));

  devices
    .command("revoke")
    .description("Revoke a device token for a role")
    .requiredOption("--device <id>", "Device id")
    .requiredOption("--role <role>", "Role name")
    .action(deviceAction((runtime) => runtime.runDevicesTokenCommand.bind(null, "revoke")));

  for (const command of devices.commands) {
    command
      .option(
        "--url <url>",
        "Gateway WebSocket URL (defaults to gateway.remote.url when configured)",
      )
      .option("--token <token>", "Gateway token (if required)")
      .option("--password <password>", "Gateway password (password auth)")
      .option("--timeout <ms>", "Timeout in ms", String(DEFAULT_DEVICES_TIMEOUT_MS))
      .option("--json", "Output JSON", false);
  }

  setCommandJsonMode(devices, "output", ({ argv }) => isDevicesMachineOutput(argv));

  applyParentDefaultHelpAction(devices);
}
