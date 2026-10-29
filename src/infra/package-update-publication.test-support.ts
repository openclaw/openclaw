import { randomUUID } from "node:crypto";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import type { UpdateRecoveryFence } from "./update-run-recovery-types.js";

export function withPublicationFence<T>(
  root: string,
  body: (fence: UpdateRecoveryFence) => Promise<T>,
) {
  return withUpdateCommandExecutor(randomUUID(), async (executor) =>
    body(await executor.enter(root)),
  );
}

export const publicationActivation = (fence: UpdateRecoveryFence) => ({
  fence,
  runtime: packageActivationRuntimeForTest(),
  onPrepared: () => {},
});
