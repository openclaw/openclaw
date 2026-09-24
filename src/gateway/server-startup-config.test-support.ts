import { vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";

export function createTestRuntimeSecretsActivator(
  prepareRuntimeSecretsSnapshot: NonNullable<
    Parameters<typeof createRuntimeSecretsActivator>[0]["prepareRuntimeSecretsSnapshot"]
  > = async () => {
    throw new Error("Unexpected secrets preparation");
  },
) {
  return createRuntimeSecretsActivator({
    logSecrets: createInfoWarnErrorLogger(),
    emitStateEvent: vi.fn(),
    prepareRuntimeSecretsSnapshot,
  });
}
