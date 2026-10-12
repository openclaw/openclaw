import { vi } from "vitest";
import type { createTalkClientGatewayControlOwner } from "../client-gateway-control.js";
import type { GatewayControlOwner } from "../client-gateway-control.types.js";

// Handler-only fixtures record provider adoption and run the adopted cleanup.
// Real owner teardown/revocation is exercised by client.test and the registered suite.
export function createBrowserConsultOwnerFixture(
  params: Parameters<typeof createTalkClientGatewayControlOwner>[0],
  observe: Pick<GatewayControlOwner, "activate" | "adoptProvider" | "close" | "control">,
) {
  let closeProvider: (() => Promise<void>) | undefined;
  const runAgentConsult = Object.assign(
    ({ prompt, signal = new AbortController().signal }: { prompt: string; signal?: AbortSignal }) =>
      params.runAgentConsult({ question: prompt }, signal),
    { claimAppend: params.runAgentConsult.claimAppend, steer: params.runAgentConsult.steer },
  );
  return {
    signal: new AbortController().signal,
    activate: observe.activate,
    adoptProvider: async (close: () => Promise<void>) => {
      closeProvider = close;
      await observe.adoptProvider(close);
    },
    close: async () => {
      await closeProvider?.();
      await params.closeLogicalSession();
      await observe.close();
    },
    assertOpen: vi.fn(),
    control: observe.control,
    runAgentConsult,
  };
}
