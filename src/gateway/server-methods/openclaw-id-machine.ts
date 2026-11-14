// OpenClaw ID operations offered only on the computer that runs the claw: direct loopback
// (`local_operator`), never over the tunnel or a proxied connection, by action:
// - rebind_prepare / rebind_commit / rebind_cancel: "Move to new keys". prepare stages the next
//   K_srv and K_gw and returns the binding the owner root signs, with Discovery's published
//   descriptor when `code` (the owner account's link code) reads it; commit takes that R-signed
//   binding and the code that publishes it; cancel deletes uncommitted staged keys;
// - reset_prepare / reset_commit: "Reset owner access" (owner reset, OCF-319). prepare returns
//   what the new root R' signs; commit takes rootPub, the R'-signed binding and, from a browser,
//   its R'-signed owner device, then removes everyone. `openclaw id reset` routes here with
//   expectedOwnerId, which binds the write to this Gateway's state owner.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawIdService } from "../openclaw-id/service.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const WHAT = { rebind: "Move to new keys", reset: "Reset owner access" } as const;

export async function handleOpenClawIdMachineAction(
  opts: GatewayRequestHandlerOptions,
  service: OpenClawIdService,
  channel: "local_operator" | "tunnel" | undefined,
  params: Record<string, unknown>,
): Promise<void> {
  const [kind, step] = String(params.action).split("_") as [keyof typeof WHAT, string];
  const refuse = (result: { code: string; detail: string }) =>
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, result.detail, { details: { code: result.code } }),
    );
  const steps = kind === "rebind" ? ["prepare", "commit", "cancel"] : ["prepare", "commit"];
  if (!steps.includes(step)) {
    refuse({ code: "malformed", detail: `unknown action ${String(params.action)}` });
    return;
  }
  if (channel !== "local_operator") {
    refuse({
      code: "not_local_operator",
      detail: `${WHAT[kind]} only works on the computer that runs this claw`,
    });
    return;
  }
  let result;
  if (kind === "rebind") {
    const code =
      typeof params.code === "string" && params.code.trim() ? params.code.trim() : undefined;
    result = await service.rebind(step as "prepare" | "commit" | "cancel", channel, {
      binding: params.binding,
      code,
    });
  } else {
    let guard: (() => void) | undefined;
    if (params.expectedOwnerId !== undefined) {
      try {
        guard = captureLocalStateMutationGuard(String(params.expectedOwnerId), opts);
      } catch (error) {
        opts.respond(false, undefined, localStateOwnerChangedError(error));
        return;
      }
    }
    result = await service.resetOwner(
      step as "prepare" | "commit",
      channel,
      { root_pub: params.rootPub, binding: params.binding, owner_device: params.ownerDevice },
      guard,
    );
  }
  if ("ok" in result && !result.ok) {
    refuse(result);
    return;
  }
  opts.respond(true, result);
}
