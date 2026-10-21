import { expect, it } from "vitest";
import { renderAssistantRequestFailureCopy } from "../../agents/failover/assistant-request-failure-copy.js";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { settleSessionWorkerReceipt } from "./session-worker-receipt.js";

it.each(["result", "settlement"] as const)(
  "retains the %s storage failure when native settlement is unknown",
  async (failed) => {
    const diskFull = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    const resultError = failed === "result" ? diskFull : new Error("Worker result was lost");
    const settlementError =
      failed === "settlement" ? diskFull : new Error("Native settlement was lost");
    const admission = createSqliteWorkerOperationAdmission(() => {
      throw new Error("This failure fixture never admits a write");
    });
    admission.port.postMessage({ kind: "native-settlement", settlement: { kind: "unknown" } }, []);
    admission.service();
    try {
      await expect(
        settleSessionWorkerReceipt(
          () => Promise.reject(resultError),
          () => ({
            admission,
            retained: { settled: Promise.resolve({ kind: "unknown", error: settlementError }) },
          }),
          () => {
            throw new Error("Unknown settlement must not inspect a commit receipt");
          },
          "Missing native receipt",
          "Pending input native commitment is unknown; do not replay",
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toMatchObject({ code: "outcome-unknown" });
        expect(formatErrorMessageWithCode(error)).toContain(resultError.message);
        expect(formatErrorMessageWithCode(error)).toContain(settlementError.message);
        expect(
          renderAssistantRequestFailureCopy({
            storageFailure: classifyGatewayStorageFailure(error),
          }),
        ).toContain("disk is full. Free up space");
        return true;
      });
    } finally {
      admission.finish();
    }
  },
);
