import { expect, it, vi } from "vitest";
import { reportDurableComposerStorageError } from "./durable-composer-persistence.ts";
it("reports policy admission separately so it cannot suppress a later database failure", () => {
  const scope = {
    gatewayOwner: "synthetic-owner",
    recoveryScope: "policy-test",
    scopeKey: "synthetic",
  };
  const report = vi.fn();
  reportDurableComposerStorageError(scope, report, "payload-too-large");
  reportDurableComposerStorageError(scope, report);
  reportDurableComposerStorageError(scope, report, "payload-too-large");
  expect(report.mock.calls).toEqual([["payload-too-large"], [undefined]]);
});
