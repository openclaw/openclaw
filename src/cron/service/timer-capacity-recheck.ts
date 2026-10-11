/** Defers a capacity wake until the current batch settles its initial reservations. */
export function createCronCapacityRecheckGate(requestRecheck: () => void) {
  let pendingActivations = 0;
  let activationsAllowRecheck = true;
  let allowRecheck: boolean | undefined;
  let requested = false;

  const resolveActivationGate = (allowed: boolean) => {
    if (allowRecheck !== undefined) {
      return;
    }
    allowRecheck = allowed;
    if (requested && allowed) {
      requestRecheck();
    }
    requested = false;
  };

  return {
    initializeActivations(count: number, allowRecheckWhenEmpty = false) {
      pendingActivations = count;
      if (count === 0) {
        resolveActivationGate(allowRecheckWhenEmpty);
      }
    },
    settleActivation(allowed: boolean) {
      if (allowRecheck !== undefined) {
        return;
      }
      activationsAllowRecheck &&= allowed;
      pendingActivations -= 1;
      if (pendingActivations === 0) {
        resolveActivationGate(activationsAllowRecheck);
      }
    },
    request() {
      if (allowRecheck === true) {
        requestRecheck();
      } else if (allowRecheck === undefined) {
        requested = true;
      }
    },
    abort() {
      resolveActivationGate(false);
    },
  };
}
