// OpenClaw ID operations offered only on the computer that runs the claw: direct loopback
// (`local_operator`), never over the tunnel or a proxied connection, by action:
// - rebind_prepare / rebind_commit / rebind_cancel: "Move to new keys". prepare stages the next
//   K_srv and K_gw and returns the binding the owner root signs, with Discovery's published
//   descriptor when `code` (the owner account's link code) reads it; commit takes that R-signed
//   binding and the code that publishes it; cancel deletes uncommitted staged keys;
// - unlink_preview / unlink: "Unlink from OpenClaw ID" (OCF-281). preview returns the claw's id,
//   address and how many people and devices lose access; unlink takes that `clawId`, signs the ClawUnlink with K_gw,
//   clears the link and all membership and sends it to Discovery (pending when Discovery can't
//   be reached).
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawIdService } from "../openclaw-id/service.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const REBIND_STEPS = {
  rebind_prepare: "prepare",
  rebind_commit: "commit",
  rebind_cancel: "cancel",
} as const;
const WHAT = { rebind: "Move to new keys", unlink: "Unlink from OpenClaw ID" } as const;

export async function handleOpenClawIdMachineAction(
  opts: GatewayRequestHandlerOptions,
  service: OpenClawIdService,
  channel: "local_operator" | "tunnel" | undefined,
  params: Record<string, unknown>,
): Promise<void> {
  const action = String(params.action);
  const refuse = (result: { code: string; detail: string }) =>
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, result.detail, { details: { code: result.code } }),
    );
  const rebindStep = Object.entries(REBIND_STEPS).find(([name]) => name === action)?.[1];
  if (!rebindStep && action !== "unlink_preview" && action !== "unlink") {
    refuse({ code: "malformed", detail: `unknown action ${action}` });
    return;
  }
  if (channel !== "local_operator") {
    refuse({
      code: "not_local_operator",
      detail: `${WHAT[rebindStep ? "rebind" : "unlink"]} only works on the computer running this claw`,
    });
    return;
  }
  const code =
    typeof params.code === "string" && params.code.trim() ? params.code.trim() : undefined;
  const result = rebindStep
    ? await service.rebind(rebindStep, channel, { binding: params.binding, code })
    : action === "unlink"
      ? await service.unlink.run(channel, params.clawId)
      : await service.unlink.preview(channel);
  if ("ok" in result && !result.ok) {
    refuse(result);
    return;
  }
  opts.respond(true, result);
}
