import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import {
  createExecutionStartedOwnerBinding,
  withPostAdmissionExecutionOwnerBinding,
} from "./execution-owner-binding.js";

const admitted: AdmittedRunContext = {
  operationalRunInstance: { instanceId: "binding-instance", runId: "binding-run" },
};

function prepareSource(runId: string) {
  return prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: { runId, instanceId: `${runId}-instance` },
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "test", state: "present" },
    },
  });
}

describe("execution owner binding settlement", () => {
  it.each(["admission", "execution"] as const)(
    "awaits the same durable binding when %s arrives first",
    async (first) => {
      const durable = createDeferred();
      const entered = createDeferred();
      const bind = vi.fn(async () => {
        entered.resolve();
        await durable.promise;
      });
      const owner = createExecutionStartedOwnerBinding(bind);
      await (first === "admission" ? owner.onPostAdmission(admitted) : owner.onExecutionStarted());
      expect(bind).not.toHaveBeenCalled();

      const second =
        first === "admission" ? owner.onExecutionStarted() : owner.onPostAdmission(admitted);
      await entered.promise;
      const repeated = owner.onExecutionStarted();
      let resumed = false;
      const resumedAfterBinding = Promise.all([second, repeated]).then(() => {
        resumed = true;
      });
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(resumed).toBe(false);
      } finally {
        durable.resolve();
        await resumedAfterBinding;
      }
      expect(resumed).toBe(true);
      expect(bind).toHaveBeenCalledOnce();
    },
  );

  it.each(["persistence failure", "owner closed"] as const)(
    "rejects admissions after %s during binding",
    async (outcome) => {
      const durable = createDeferred();
      const entered = createDeferred();
      const source = prepareSource("binding-rejection");
      const bind = vi.fn(async () => {
        entered.resolve();
        await durable.promise;
      });
      const owner = withPostAdmissionExecutionOwnerBinding(source, bind);
      try {
        const first = owner.admit("gateway");
        await entered.promise;
        const attempts = [first];
        if (outcome === "persistence failure") {
          attempts.push(owner.admit("gateway"));
        }
        const settled = Promise.allSettled(attempts);
        const failure = new Error("binding persistence failed");
        if (outcome === "persistence failure") {
          durable.reject(failure);
          expect(await settled).toEqual([
            { status: "rejected", reason: failure },
            { status: "rejected", reason: failure },
          ]);
        } else {
          owner.close();
          durable.resolve();
          await expect(first).rejects.toThrow("authority is no longer active");
          await settled;
        }
        expect(bind).toHaveBeenCalledOnce();
      } finally {
        source.close();
      }
    },
  );
});
