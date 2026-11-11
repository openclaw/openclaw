import path from "node:path";
import { afterEach } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import { runCleanups, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createQaPreparedRepoCliCommand } from "../../../helpers/qa-prepared-repo-cli.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
type GatewayOptions = Parameters<ReturnType<typeof createQaGatewayChild>["start"]>[0];

export async function readMockRequests(baseUrl: string, after?: number) {
  const response = await fetch(
    `${baseUrl}/debug/requests${after === undefined ? "" : `?after=${after}`}`,
  );
  if (!response.ok) {
    throw new Error(
      `mock request log failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as MockOpenAiRequestSnapshot[];
}

export function useMediaGateway() {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(() => runCleanups(cleanups, "media gateway cleanup failed"));
  return {
    track(cleanup: () => Promise<void>) {
      cleanups.push(cleanup);
    },
    async start(options: Pick<GatewayOptions, "primaryModel" | "alternateModel" | "mutateConfig">) {
      const state = createQaBusState();
      const transport = createQaChannelTransport(state);
      const bus = await startQaBusServer({ state });
      cleanups.push(() => bus.stop());
      const mock = await startQaMockOpenAiServer();
      cleanups.push(() => mock.stop());
      const owner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(owner));
      const gateway = await owner.start({
        repoRoot: REPO_ROOT,
        command: createQaPreparedRepoCliCommand(REPO_ROOT),
        initializeCurrentRuntimeState: true,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        transport,
        transportBaseUrl: bus.baseUrl,
        controlUiEnabled: false,
        ...options,
      });
      await transport.waitReady({ gateway });
      return { state, transport, mock, gateway };
    },
  };
}
