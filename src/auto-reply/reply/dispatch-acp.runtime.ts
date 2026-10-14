// Lazily loads ACP dispatch runtime pieces outside the normal reply hot path.
import { createLazyPromise } from "../../shared/lazy-promise.js";

type ShouldBypassAcpDispatchForCommand =
  (typeof import("./dispatch-acp-command-bypass.js"))["shouldBypassAcpDispatchForCommand"];
type TryDispatchAcpReply = (typeof import("./dispatch-acp.js"))["tryDispatchAcpReplyCore"];

const loadDispatchAcp = createLazyPromise(() => import("./dispatch-acp.js"));
const loadDispatchAcpCommandBypass = createLazyPromise(
  () => import("./dispatch-acp-command-bypass.js"),
);

export async function shouldBypassAcpDispatchForCommand(
  ...args: Parameters<ShouldBypassAcpDispatchForCommand>
): Promise<Awaited<ReturnType<ShouldBypassAcpDispatchForCommand>>> {
  const mod = await loadDispatchAcpCommandBypass();
  return mod.shouldBypassAcpDispatchForCommand(...args);
}

export async function tryDispatchAcpReply(
  ...args: Parameters<TryDispatchAcpReply>
): Promise<Awaited<ReturnType<TryDispatchAcpReply>>> {
  const mod = await loadDispatchAcp();
  return await mod.tryDispatchAcpReplyCore(...args);
}
