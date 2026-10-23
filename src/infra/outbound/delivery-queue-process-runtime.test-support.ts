export const deliveryQueueProcessEntrypoints = {
  preparation: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "delivery-queue-preparation.child.test-support",
    distWorkerPath: "infra/outbound/delivery-queue-preparation.child.test-support.js",
  },
  mediaSpoolCrash: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "delivery-queue-media-spool.crash-child.test-support",
    distWorkerPath: "infra/outbound/delivery-queue-media-spool.crash-child.test-support.js",
  },
} as const;
