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

  it("shares post-admission persistence failure with concurrent retries", async () => {
    const durable = createDeferred();
    const entered = createDeferred();
    const source = prepareSource("binding-failure");
    const bind = vi.fn(async () => {
      entered.resolve();
      await durable.promise;
    });
    const owner = withPostAdmissionExecutionOwnerBinding(source, bind);
    try {
      const first = owner.admit("gateway");
      await entered.promise;
      const second = owner.admit("gateway");
      const settled = Promise.allSettled([first, second]);
      const failure = new Error("binding persistence failed");
      durable.reject(failure);
      expect(await settled).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      expect(bind).toHaveBeenCalledOnce();
    } finally {
      source.close();
    }
  });

  it.each(["wrapper", "source"] as const)(
    "rejects admission when the %s closes during binding persistence",
    async (closedOwner) => {
      const source = prepareSource(`binding-close-${closedOwner}`);
      const entered = createDeferred();
      const durable = createDeferred();
      const owner = withPostAdmissionExecutionOwnerBinding(source, async () => {
        entered.resolve();
        await durable.promise;
      });
      try {
        const pending = owner.admit("gateway");
        await entered.promise;
        (closedOwner === "wrapper" ? owner : source).close();
        durable.resolve();
        await expect(pending).rejects.toThrow("authority is no longer active");
      } finally {
        source.close();
      }
    },
  );
});
