import type { Mock } from "vitest";
import type { GatewayServiceState } from "../../daemon/service.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

export type OriginalServiceFixture = {
  state: OpenClawTestState;
  rootA: string;
  rootB: string;
  serviceNodeRunner: string;
  before: PreManagedServiceStop;
  serviceState: GatewayServiceState;
  mocks: {
    capability: Mock;
    nativeRestart: Mock;
    nativeInstall: Mock;
    restart: Mock;
    health: Mock;
    readiness: Mock;
  };
};
