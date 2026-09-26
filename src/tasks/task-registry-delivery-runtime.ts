import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";

// Runtime delivery seam for task terminal/state-change notifications.
export { sendMessage } from "../infra/outbound/message.js";

export async function prepareTaskControlUiSessionUrl(assertCurrent: () => void) {
  const { config } = await captureRuntimeConfigAsyncReader({ assertCurrent, capture: true })();
  assertCurrent();
  return (params: { sessionKey: string; fallbackAgentId?: string }): string | undefined => {
    assertCurrent();
    return resolveControlUiSessionUrl(config, { ...params, exactKey: true });
  };
}
