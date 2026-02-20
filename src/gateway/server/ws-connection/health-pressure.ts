export function shouldThrottleHealthRequest(params: {
  method: string;
  probe: boolean;
  cachedAvailable: boolean;
  nowMs: number;
  lastHealthRequestAtMs: number;
  minIntervalMs: number;
}): boolean {
  if (params.method !== "health") {
    return false;
  }
  if (params.probe) {
    return false;
  }
  if (!params.cachedAvailable) {
    return false;
  }
  if (params.minIntervalMs <= 0) {
    return false;
  }
  return params.nowMs - params.lastHealthRequestAtMs < params.minIntervalMs;
}
