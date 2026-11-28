// `openclaw id unlink`: ends this claw's link to OpenClaw ID for good (OCF-281). The Gateway
// accepts it only from a direct-loopback client. The warning names what is lost before the
// owner confirms: the people and devices that lose access, the address and the name.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { UnlinkResult } from "../gateway/openclaw-id/service-unlink.js";
import type { UnlinkPreview } from "../gateway/openclaw-id/unlink-operations.js";
import { throwExpectedCliError } from "./expected-cli-error.js";
import { callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";
import { promptYesNo } from "./prompt.js";

type UnlinkOpts = GatewayRpcOpts & { json?: boolean; yes?: boolean };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The name part of `<name>-<account tag>.<domain>`, the claw name that is retired. */
function clawNameOf(hostname: string): string {
  return (hostname.split(".")[0] ?? hostname).replace(/-[0-9a-hjkmnp-tv-z]{5}$/, "");
}

/** The warning shown before unlinking, with the live counts. */
function describeUnlinkWarning(preview: UnlinkPreview): string {
  const host = sanitizeTerminalText(preview.hostname);
  const parts = [
    preview.ownerDevices ? plural(preview.ownerDevices, "owner device", "owner devices") : "",
    preview.memberDevices ? plural(preview.memberDevices, "member device", "member devices") : "",
    preview.nodes ? plural(preview.nodes, "node", "nodes") : "",
  ].filter(Boolean);
  return [
    `Unlink ${host} from OpenClaw ID?`,
    `  - ${plural(preview.people, "person", "people")} and ${plural(preview.devices, "device", "devices")} lose access now${parts.length ? ` (${parts.join(", ")})` : ""}. Members are removed; linking again starts with no one.`,
    `  - https://${host} stops working at once.`,
    `  - The name "${sanitizeTerminalText(clawNameOf(preview.hostname))}" can never be used again, by any account.`,
    "  - Conversations and everything else on this computer stay. You can link it again later as a new claw.",
  ].join("\n");
}

/** What happened, and what the owner should do next. */
function describeUnlinkResult(result: UnlinkResult): string {
  const host = sanitizeTerminalText(result.hostname);
  const lines = [`Unlinked ${host}.`];
  if (result.discovery === "confirmed") {
    lines.push("OpenClaw ID retired the address. Its name can't be used again.");
  } else if (result.discovery === "local_only") {
    lines.push(
      "OpenClaw ID never registered this claw, so it had no address to retire. It is unlinked on this computer.",
    );
  } else if (result.discovery === "pending") {
    lines.push(
      "OpenClaw ID couldn't be reached. This computer sends the unlink as soon as it can; until then the address may still be listed (openclaw id status).",
    );
  } else if (result.discovery === "refused") {
    lines.push(
      `OpenClaw ID refused the unlink (${sanitizeTerminalText(result.discoveryCode ?? "unknown")}), so the address may still be listed. This computer no longer accepts anyone through it.`,
    );
  }
  if (result.followUpError !== undefined) {
    lines.push(
      `A step after unlinking failed: ${sanitizeTerminalText(result.followUpError)}`,
      "The claw stays unlinked. Restart the Gateway to finish closing remote sessions.",
    );
  }
  return lines.join("\n");
}

/** Status lines for unlinked claws OpenClaw ID has not confirmed (`openclaw id status`). */
export function describePendingUnlinks(
  pending: ReadonlyArray<{ hostname: string; refused?: string }>,
): string[] {
  return pending.map(({ hostname, refused }) => {
    const host = sanitizeTerminalText(hostname);
    return refused
      ? `Unlink refused: ${host} is unlinked here, but OpenClaw ID refused to retire it (${sanitizeTerminalText(refused)}).`
      : `Unlink pending: ${host} is unlinked here; OpenClaw ID gets the unlink when it can be reached.`;
  });
}

export async function runUnlink(
  opts: UnlinkOpts,
  write: (json: unknown, text: string) => void,
): Promise<void> {
  if (opts.json && !opts.yes) {
    throwExpectedCliError("--json needs --yes: unlinking asks for confirmation otherwise.");
  }
  const authority = (params: Record<string, unknown>) =>
    callGatewayFromCli("openclawId.authority", opts, params, { scopes: ["operator.admin"] });
  // SAFETY: unlink_preview answers the authority's UnlinkPreview shape.
  const preview = (await authority({ action: "unlink_preview" })) as UnlinkPreview;
  if (!opts.json) {
    process.stdout.write(`${describeUnlinkWarning(preview)}\n`);
  }
  if (!opts.yes) {
    if (!(await promptYesNo("Unlink this claw?"))) {
      write({ unlinked: false }, "Not unlinked. Nothing changed.");
      return;
    }
  }
  // SAFETY: unlink answers the service's UnlinkResult contract.
  const result = (await authority({ action: "unlink", clawId: preview.claw_id })) as UnlinkResult;
  write(result, describeUnlinkResult(result));
  if (result.followUpError !== undefined || result.discovery === "refused") {
    process.exitCode = 2;
  }
}
