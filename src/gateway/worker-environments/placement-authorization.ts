export type WorkerPlacementAuthorization = (() => void) & {
  assertWorkerGrant?: () => void;
  assertWorkerLifetime?: () => void;
};

/** Keep prepared grant authority attached while callers add signal or provider checks. */
export function composePlacementAuthorization(
  source: WorkerPlacementAuthorization | undefined,
  check: () => void,
): WorkerPlacementAuthorization {
  return Object.assign(
    () => {
      check();
      source?.();
    },
    {
      assertWorkerGrant: () => {
        check();
        (source?.assertWorkerGrant ?? source)?.();
      },
      assertWorkerLifetime: () => {
        check();
        (source?.assertWorkerLifetime ?? source)?.();
      },
    },
  );
}
