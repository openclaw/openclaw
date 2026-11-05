import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";

type GatewayAuxHandlerParams = Parameters<typeof createGatewayAuxHandlers>[0];

export function createGatewayAuxHandlerTestParams(
  overrides: Partial<GatewayAuxHandlerParams> = {},
): GatewayAuxHandlerParams {
  return {
    scheduler: overrides.scheduler ?? createTestGatewayScheduler(),
    log: {},
    getNativeApprovalRouteCoordinator: () => undefined,
    activateRuntimeSecrets: createTestRuntimeSecretsActivator(),
    sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
      current: undefined,
      required: null,
    }),
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    clients: [],
    channelManager: {
      startChannel: async () => new Map(),
      stopChannel: async () => {},
      isManuallyStopped: () => false,
      resolveRuntimeAccountId: (_channel, accountId) => accountId,
    },
    logChannels: { info: () => {} },
    ...overrides,
  };
}
