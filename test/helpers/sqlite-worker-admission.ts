import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import * as workerAdmission from "../../src/infra/sqlite-worker-operation-admission.js";

type AdmissionStage = workerAdmission.SqliteWorkerAdmissionRequest["stage"];

/** Observe one serial native operation without replacing its worker, grant, or receipts. */
export function observeSqliteWorkerAdmission<T>(options: {
  selectSubmission: (command: unknown) => T | undefined;
  beforeAdmit?: (stage: AdmissionStage) => void;
  afterAdmit?: (stage: AdmissionStage) => void;
}) {
  const posting = vi.spyOn(Worker.prototype, "postMessage");
  const submissions = () =>
    posting.mock.calls.flatMap(([message]) => {
      if (
        !isRecord(message) ||
        message.type !== "execute" ||
        !(message.input instanceof Uint8Array)
      ) {
        return [];
      }
      const submission = options.selectSubmission(deserialize(message.input));
      return submission === undefined ? [] : [submission];
    });
  const stages: AdmissionStage[] = [];
  const decisions: Array<{ stage: AdmissionStage; granted: boolean; error?: unknown }> = [];
  let selected = false;
  const original = workerAdmission.createSqliteWorkerOperationAdmission;
  const admission = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) => {
      let target = false;
      return original((request, grant) => {
        // Select this operation at transaction entry, never an earlier observation
        // or a later cleanup. All other admissions still call through unchanged.
        if (!selected && request.stage === "transaction" && submissions().length > 0) {
          selected = true;
          target = true;
        }
        if (!target) {
          admit(request, grant);
          return;
        }
        stages.push(request.stage);
        try {
          options.beforeAdmit?.(request.stage);
          admit(request, grant);
          decisions.push({ stage: request.stage, granted: true });
        } catch (error) {
          decisions.push({ stage: request.stage, granted: false, error });
          throw error;
        }
        // The original owner has returned from its real grant. Observers cannot
        // substitute authority or manufacture native commit/settlement facts.
        options.afterAdmit?.(request.stage);
      }, attachment);
    });
  return {
    stages,
    decisions,
    submissions,
    restore: () => {
      admission.mockRestore();
      posting.mockRestore();
    },
  };
}
