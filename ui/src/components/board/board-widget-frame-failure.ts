import type { BoardWidget } from "../../lib/board/types.ts";
import { isLoopbackHostname } from "../../lib/gateway-locality.ts";
import { t } from "../../lib/reactive/i18n.ts";

// Without mcp.apps.sandboxOrigin the sandbox URL is the gateway origin with the
// sandbox port substituted. On a non-loopback host that derived port often sits
// behind a reverse proxy or tunnel that does not route it, and the browser
// cannot distinguish that from a real authorization failure or an unreachable
// sandbox — so terminal messages keep their fact but add the deployment hint
// operators otherwise never find.
export function derivedRemoteSandboxOrigin(
  widget: Pick<BoardWidget, "sandboxOrigin">,
  resolvedSandboxOrigin: string,
): boolean {
  return (
    !widget.sandboxOrigin &&
    Boolean(resolvedSandboxOrigin) &&
    !isLoopbackHostname(new URL(resolvedSandboxOrigin).hostname)
  );
}

export function resolveBoardFrameFailureMessage(
  widget: Pick<BoardWidget, "sandboxOrigin">,
  resolvedSandboxOrigin: string,
): string {
  return derivedRemoteSandboxOrigin(widget, resolvedSandboxOrigin)
    ? t("board.widget.sandboxOriginRequired")
    : t("board.widget.frameAuthorizationFailed");
}
