import "./session-entry-patch-delivery.test-support.js";
import { expect, it, vi } from "vitest";
import { renderAssistantRequestFailureCopy } from "../../agents/failover/assistant-request-failure-copy.js";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { patchSessionEntryCore as patchInternalSessionEntry } from "./session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";

const { getSessionEntryPatchDelivery, observeCommitAdmission } =
  await import("./session-entry-patch-delivery.test-support.js");
const delivery = getSessionEntryPatchDelivery();

it("retains the storage failure when unknown patch publication also fails", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const storageFailure = Object.assign(new Error("database or disk is full"), {
      code: "SQLITE_FULL",
    });
    const publicationFailure = new Error("Session fact installation failed");
    const getAdmission = observeCommitAdmission();
    delivery.afterCommit = () => {
      const nativeAdmission = getAdmission();
      expect(nativeAdmission).toBeDefined();
      if (!nativeAdmission) {
        throw new Error("Patch did not reach native commit admission");
      }
      vi.spyOn(nativeAdmission, "settlement", "get").mockReturnValue({ kind: "unknown" });
      throw storageFailure;
    };
    const update = vi.fn(() => ({ label: "committed once" }));
    await expect(
      patchInternalSessionEntry(f.scope, update, {
        workerGuard: {},
        onCommitted() {
          throw publicationFailure;
        },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(hasSqliteWorkerOutcomeUnknown(error)).toBe(true);
      expect(formatErrorMessageWithCode(error)).toContain(publicationFailure.message);
      const storageOutcome = classifyGatewayStorageFailure(error);
      expect(storageOutcome).toBe("session_actor_reconciliation");
      expect(
        renderAssistantRequestFailureCopy({
          storageFailure: storageOutcome,
        }),
      ).toMatch(/check.*history.*before trying again/i);
      return true;
    });
    expect(update).toHaveBeenCalledOnce();
    expect(f.read()?.label).toBe("committed once");
  });
});
