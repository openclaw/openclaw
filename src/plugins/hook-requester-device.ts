// A run's hook contexts report the device that sent its turn. Steering can add
// another person's or device's input to the same run without changing that
// field, so the run records every injected input's device here and hook
// dispatch withholds the device once any input came from elsewhere.
const injectedInputDevices = new Map<string, { devices: Set<string>; recordedAt: number }>();
// Entries are pruned on write; a run that outlives this keeps the cut-back,
// device-free contexts only until the next record.
const RETAIN_MS = 24 * 60 * 60_000;

/** Records the device of human input accepted into an active run; undefined is a device-less source. */
export function recordRunInjectedInputDevice(
  runId: string | undefined,
  deviceId: string | undefined,
): void {
  if (!runId) {
    return;
  }
  const now = Date.now();
  for (const [id, entry] of injectedInputDevices) {
    if (now - entry.recordedAt > RETAIN_MS) {
      injectedInputDevices.delete(id);
    }
  }
  const entry = injectedInputDevices.get(runId) ?? { devices: new Set<string>(), recordedAt: now };
  entry.devices.add(deviceId?.trim() ?? "");
  entry.recordedAt = now;
  injectedInputDevices.set(runId, entry);
}

type DeviceBearingContext = {
  runId?: string;
  requesterDeviceId?: string;
  requester?: { deviceId?: string };
};

/** Drops the reported device from a hook context when the run holds input from another source. */
export function projectHookRequesterDevice<T>(ctx: T): T {
  const context = ctx as DeviceBearingContext | undefined;
  const entry = context?.runId ? injectedInputDevices.get(context.runId) : undefined;
  if (!entry || !context) {
    return ctx;
  }
  const reported = context.requesterDeviceId ?? context.requester?.deviceId;
  if (!reported || [...entry.devices].every((device) => device === reported)) {
    return ctx;
  }
  const { requesterDeviceId: _agentDevice, ...rest } = context;
  if (!rest.requester?.deviceId) {
    return rest as T;
  }
  const { deviceId: _toolDevice, ...requester } = rest.requester;
  return { ...rest, requester } as T;
}
