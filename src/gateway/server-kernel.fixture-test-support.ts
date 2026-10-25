import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServerOptions } from "./server-public.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

export async function createKernelFixture(
  label: string,
  options: Parameters<typeof createOpenClawTestState>[0] & { port?: number; token?: string } = {},
) {
  const { port = await getFreePort(), token = `${label}-token`, ...stateOptions } = options;
  const state = await createOpenClawTestState({
    label,
    ...stateOptions,
    env: { ...KERNEL_TEST_ENV, ...stateOptions.env },
  });
  const serverOptions = {
    auth: { mode: "token" as const, token },
    bind: "loopback" as const,
    controlUiEnabled: false,
    sidecarStartup: "defer" as const,
  };
  return {
    state,
    port,
    serverOptions,
    async configure(config: OpenClawConfig = {}) {
      await state.writeConfig({
        ...config,
        gateway: {
          auth: serverOptions.auth,
          controlUi: { enabled: false },
          port,
          ...config.gateway,
        },
      });
      state.applyEnv();
    },
    open: (overrides: GatewayServerOptions = {}) =>
      createGatewayKernel(port, { ...serverOptions, ...overrides }),
  };
}

export async function closeKernelFixture(
  kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined,
  state: OpenClawTestState,
  beforeCleanup?: () => unknown,
) {
  try {
    await kernel?.closeOnStartupFailure();
  } finally {
    try {
      await beforeCleanup?.();
    } finally {
      await state.cleanup();
    }
  }
}
