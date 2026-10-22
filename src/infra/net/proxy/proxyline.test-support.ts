import type { ProxylineHandle } from "@openclaw/proxyline";
import type { MockResult } from "vitest";

// Inherited routing has process lifetime; fixtures own its mocked handles.
export function stopMockedProxylineHandles(
  results: readonly MockResult<Pick<ProxylineHandle, "stop">>[],
): void {
  for (const result of results) {
    if (result.type === "return") {
      result.value.stop();
    }
  }
}
