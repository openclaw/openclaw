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

function inputCameOnlyFrom(runId: string | undefined, deviceId: string): boolean {
  const entry = runId ? injectedInputDevices.get(runId) : undefined;
  return !entry || [...entry.devices].every((device) => device === deviceId);
}

type ExecOwner = { runId: string; ownerDeviceId?: string };
type DeviceBearingContext = {
  runId?: string;
  requesterDeviceId?: string;
  requester?: { deviceId?: string };
  execRequestOwners?: readonly ExecOwner[];
};

/**
 * Drops each device a hook context reports for a run that holds input from another source:
 * the current run's requester device and the device of every exec request owner it continues.
 */
export function projectHookRequesterDevice<T>(ctx: T): T {
  // SAFETY: agent and tool hook contexts are plain objects; the fields read here are optional.
  const context = ctx as DeviceBearingContext | undefined;
  if (!context) {
    return ctx;
  }
  const reported = context.requesterDeviceId ?? context.requester?.deviceId;
  const dropReported = reported ? !inputCameOnlyFrom(context.runId, reported) : false;
  const owners = context.execRequestOwners;
  const dropOwnerDevice = owners?.some(
    (owner) => owner.ownerDeviceId && !inputCameOnlyFrom(owner.runId, owner.ownerDeviceId),
  );
  if (!dropReported && !dropOwnerDevice) {
    return ctx;
  }
  const { requesterDeviceId, requester, execRequestOwners, ...rest } = context;
  const projected: DeviceBearingContext = { ...rest };
  if (requesterDeviceId && !dropReported) {
    projected.requesterDeviceId = requesterDeviceId;
  }
  if (requester) {
    const { deviceId, ...withoutDevice } = requester;
    projected.requester = deviceId && !dropReported ? requester : withoutDevice;
  }
  if (execRequestOwners) {
    projected.execRequestOwners = Object.freeze(
      execRequestOwners.map((owner) => {
        if (!owner.ownerDeviceId || inputCameOnlyFrom(owner.runId, owner.ownerDeviceId)) {
          return owner;
        }
        const { ownerDeviceId: _steered, ...withoutDevice } = owner;
        return Object.freeze(withoutDevice);
      }),
    );
  }
  // SAFETY: projected is ctx with only optional device fields removed, so it still satisfies T.
  return projected as T;
}
