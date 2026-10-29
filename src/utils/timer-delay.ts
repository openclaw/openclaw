import { resolveSafeTimeoutDelayMs } from "../../packages/gateway-client/src/timeouts.js";

export {
  addSafeTimeoutDelayGraceMs,
  resolveSafeTimeoutDelayMs,
} from "../../packages/gateway-client/src/timeouts.js";

export function setSafeTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
  return setTimeout(callback, resolveSafeTimeoutDelayMs(delayMs));
}
