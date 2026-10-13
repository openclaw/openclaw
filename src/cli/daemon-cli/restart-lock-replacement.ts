import {
  type GatewayLockIdentity,
  isSameGatewayLockIdentity,
  readActiveGatewayLockIdentity,
} from "../../infra/gateway-lock.js";
import { sleep } from "../../utils.js";

type GatewayLockReplacementWaitResult =
  | {
      status: "replacement";
      attemptsUsed: number;
      lockIdentity: GatewayLockIdentity;
    }
  | { status: "timeout" };

export async function waitForGatewayLockReplacement(params: {
  previousLockIdentity: GatewayLockIdentity;
  env?: NodeJS.ProcessEnv;
  attempts: number;
  delayMs: number;
  waitIndefinitelyForPreviousOwner: boolean;
}): Promise<GatewayLockReplacementWaitResult> {
  let attemptsUsed = 0;
  let previousOwnerReleased = false;

  for (;;) {
    // A failed inspection is not evidence that the previous owner released its lock.
    const currentLockIdentity = await readActiveGatewayLockIdentity({ env: params.env }).catch(
      () => null,
    );
    if (
      !previousOwnerReleased &&
      currentLockIdentity !== null &&
      (!currentLockIdentity ||
        !isSameGatewayLockIdentity(params.previousLockIdentity, currentLockIdentity))
    ) {
      previousOwnerReleased = true;
      if (params.waitIndefinitelyForPreviousOwner) {
        attemptsUsed = 0;
      }
    }

    if (
      previousOwnerReleased &&
      currentLockIdentity &&
      !isSameGatewayLockIdentity(params.previousLockIdentity, currentLockIdentity)
    ) {
      return { status: "replacement", attemptsUsed, lockIdentity: currentLockIdentity };
    }

    if (!params.waitIndefinitelyForPreviousOwner || previousOwnerReleased) {
      if (attemptsUsed >= params.attempts) {
        return { status: "timeout" };
      }
      attemptsUsed += 1;
    }
    await sleep(params.delayMs);
  }
}
