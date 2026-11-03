import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enWorkerCapacity = {
  capacityMeter: {
    workerSlots: "{used} of {total} slots busy",
    unavailable: "Slot utilization unavailable",
    execHost: "Codex exec",
  },
} satisfies TranslationMap;

export const registerWorkerCapacityEnglish = Object.assign(
  () => {
    Object.assign(en.capacityMeter, enWorkerCapacity.capacityMeter);
  },
  { catalog: enWorkerCapacity },
);
