import type { DiagnosticMemoryUsage } from "../infra/diagnostic-process-types.js";
import { normalizeDiagnosticWorkerScript } from "../infra/worker-diagnostic-script.js";
import {
  assignOptionalFields,
  readObject,
  readOptionalPositiveInteger,
  readRequiredNumber,
} from "./diagnostic-stability-readers.js";

export function readMemoryUsage(input: unknown, label: string): DiagnosticMemoryUsage {
  const memory = readObject(input, label);
  const result: DiagnosticMemoryUsage = {
    rssBytes: readRequiredNumber(memory.rssBytes, `${label}.rssBytes`),
    heapTotalBytes: readRequiredNumber(memory.heapTotalBytes, `${label}.heapTotalBytes`),
    heapUsedBytes: readRequiredNumber(memory.heapUsedBytes, `${label}.heapUsedBytes`),
    externalBytes: readRequiredNumber(memory.externalBytes, `${label}.externalBytes`),
    arrayBuffersBytes: readRequiredNumber(memory.arrayBuffersBytes, `${label}.arrayBuffersBytes`),
  };
  assignOptionalFields(
    result,
    memory,
    label,
    [
      "workerCount",
      "workerHeapSampledCount",
      "workerHeapTotalBytes",
      "workerHeapUsedBytes",
      "workerExternalBytes",
      "workerArrayBuffersBytes",
      "workerArrayBuffersSampledCount",
    ],
    readOptionalPositiveInteger,
  );
  if (memory.workerMemoryScope === "direct") {
    result.workerMemoryScope = memory.workerMemoryScope;
  }
  if (
    memory.workerMemoryCoverage === "complete" ||
    memory.workerMemoryCoverage === "partial" ||
    memory.workerMemoryCoverage === "unavailable"
  ) {
    result.workerMemoryCoverage = memory.workerMemoryCoverage;
  }
  // The bundle byte limit bounds imported arrays; copy only known numeric fields and script names.
  if (Array.isArray(memory.workerHeaps)) {
    result.workerHeaps = memory.workerHeaps.map((value, index) => {
      const entryLabel = `${label}.workerHeaps[${index}]`;
      const worker = readObject(value, entryLabel);
      const sample: NonNullable<DiagnosticMemoryUsage["workerHeaps"]>[number] = {
        script: normalizeDiagnosticWorkerScript(worker.script),
        heapUsed: readRequiredNumber(worker.heapUsed, `${entryLabel}.heapUsed`),
        heapTotal: readRequiredNumber(worker.heapTotal, `${entryLabel}.heapTotal`),
      };
      assignOptionalFields(
        sample,
        worker,
        entryLabel,
        ["threadId", "external", "arrayBuffers", "sampleAgeMs"],
        readOptionalPositiveInteger,
      );
      return sample;
    });
  }
  if (Array.isArray(memory.workerMemoryMissing)) {
    result.workerMemoryMissing = memory.workerMemoryMissing.flatMap((value, index) => {
      const entryLabel = `${label}.workerMemoryMissing[${index}]`;
      const worker = readObject(value, entryLabel);
      if (
        worker.reason !== "pending" &&
        worker.reason !== "stale" &&
        worker.reason !== "unavailable"
      ) {
        return [];
      }
      return [
        {
          script: normalizeDiagnosticWorkerScript(worker.script),
          threadId: readRequiredNumber(worker.threadId, `${entryLabel}.threadId`),
          reason: worker.reason,
        },
      ];
    });
  }
  return result;
}
