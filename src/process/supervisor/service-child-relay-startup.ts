import type { ChildProcess } from "node:child_process";
import { sendServiceChildMessage, type ServiceChildStart } from "./service-child-protocol.js";
import type {
  prepareServiceChildRelay,
  ServiceChildRelayParams,
} from "./service-child-relay-preparation.js";
import { joinStartupFailureCleanup } from "./service-child-relay-retirement.js";
import type { ManagedRunStdin } from "./types.js";

/** Join startup admission and secret delivery before handing caller input to the command. */
export async function startServiceChildRelay(options: {
  params: ServiceChildRelayParams;
  preparation: ReturnType<typeof prepareServiceChildRelay>;
  child: ChildProcess;
  start: ServiceChildStart;
  stdin: ManagedRunStdin | undefined;
  startup: Promise<void>;
  constructionAbort: Promise<never>;
  onConstructionAbort: () => void;
  getWaitError: () => Error | undefined;
  getStartupErrorAckDelivery: () => Promise<void> | undefined;
  cleanup: Promise<void>;
  onFailure: () => void;
  removeConstructionAbortListener: () => void;
}): Promise<void> {
  const { params, preparation, child, start, stdin } = options;
  using delivery = preparation.transferSecretInput();
  try {
    params.assertCurrent?.();
    if (params.abortSignal?.aborted) {
      options.onConstructionAbort();
    }
    params.beforeSpawn?.();
    await Promise.race([sendServiceChildMessage(child, start), options.constructionAbort]);
    params.assertCurrent?.();
    const [startupResult, secretDeliveryResult] = await Promise.allSettled([
      options.startup,
      delivery?.deliverTo(child, { abortSignal: params.abortSignal }),
    ]);
    // Preserve admission failure over the secret pipe it closes as a consequence.
    if (startupResult.status === "rejected") {
      throw await joinStartupFailureCleanup(
        startupResult.reason,
        options.getStartupErrorAckDelivery(),
        options.cleanup,
      );
    }
    if (secretDeliveryResult.status === "rejected") {
      throw secretDeliveryResult.reason;
    }
    if (params.input !== undefined && params.prepareInput) {
      await params.prepareInput();
    }
    const waitError = options.getWaitError();
    if (params.abortSignal?.aborted || waitError) {
      throw waitError ?? new Error("service child construction aborted");
    }
    params.assertCurrent?.();
    if (params.input !== undefined) {
      stdin?.write(params.input);
      stdin?.end();
    } else if (params.stdinMode === "pipe-closed") {
      stdin?.end();
    }
  } catch (error) {
    options.onFailure();
    throw error;
  } finally {
    options.removeConstructionAbortListener();
  }
}
