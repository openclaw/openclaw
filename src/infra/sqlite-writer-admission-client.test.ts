import { afterEach, expect, it, vi } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationContext } from "./sqlite-worker-operation-settlement.js";
import { SqliteWorkerSlotCustody } from "./sqlite-worker-request-custody.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-writer-admission-client.js";

afterEach(() => vi.restoreAllMocks());

it("keeps worker admission requests independent of host lock-record loading", () => {
  expect(
    findSourceImportBackedges("src/infra/sqlite-writer-admission-client.ts", [
      "src/infra/gateway-state-owner-record.ts",
    ]),
  ).toEqual([]);
});

it.each(["current", "revoked after grant"] as const)(
  "clears a prior refusal only after fresh live authority (%s)",
  (custodyState) => {
    const refusal = new Error("Synthetic first-stage refusal");
    const custody = new SqliteWorkerSlotCustody().createRequest();
    custody.activate();
    custody.accept();
    let requests = 0;
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
      if (++requests === 1) {
        throw refusal;
      }
      grant(() => {
        if (custodyState === "revoked after grant") {
          custody.retire();
        }
      });
    });
    const owner: SqliteWorkerOperationContext = {
      port: admission.port,
      requestCustody: custody.descriptor,
    };
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    try {
      withSqliteWorkerOperationAdmission(owner, () => {
        expect(() =>
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined }),
        ).toThrow("SQLite transaction admission was refused");
        expect(owner.refusal).toBeDefined();
        const request = () =>
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        if (custodyState === "current") {
          request();
          expect(owner.refusal).toBeUndefined();
        } else {
          expect(request).toThrow("SQLite worker request custody is revoked");
          expect(owner.refusal).toMatchObject({
            message: "SQLite worker request custody is revoked",
          });
        }
      });
      expect(requests).toBe(2);
      expect(admission.failure).toBe(refusal);
    } finally {
      admission.finish();
    }
  },
);
