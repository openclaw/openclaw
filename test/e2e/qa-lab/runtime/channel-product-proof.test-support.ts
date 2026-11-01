import { afterEach } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type GatewayOptions = Parameters<ReturnType<typeof createQaLiveLaneGateway>["start"]>[0];

export function useChannelProductProof() {
  const cleanups: Array<() => unknown> = [];
  const cleanup = (stop: () => unknown) => cleanups.push(stop);
  afterEach(() => runQaGatewayFixture(async () => {}, ...cleanups.splice(0).toReversed()));
  return {
    cleanup,
    async start(
      options: Partial<GatewayOptions> | ((baseUrl: string) => Partial<GatewayOptions>) = {},
    ) {
      const state = createQaBusState();
      const transport = createQaChannelTransport(state);
      const bus = await startQaBusServer({ state });
      cleanup(() => bus.stop());
      const owner = createQaLiveLaneGateway();
      cleanup(() => stopQaGatewayFixture(owner));
      const harness = await owner.start({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        controlUiEnabled: false,
        ...(typeof options === "function" ? options(bus.baseUrl) : options),
        transport,
        transportBaseUrl: bus.baseUrl,
      });
      return { ...harness, state, transport, bus };
    },
  };
}
