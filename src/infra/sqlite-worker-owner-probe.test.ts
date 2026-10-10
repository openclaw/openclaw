import { AsyncLocalStorage } from "node:async_hooks";
import { receiveMessageOnPort } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperationOptions } from "../state/openclaw-state-worker-contract.js";
import type { DomainScope } from "../state/openclaw-state-worker-store.types.js";
import * as admissionModule from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("preserves synchronous admission ordering and refusal (%s)", (refuse) => {
  const events: string[] = [];
  const failure = new Error("synthetic refusal");
  let receivedAttachment: unknown;
  const create: typeof admissionModule.createSqliteWorkerOperationAdmission = (...args) => {
    receivedAttachment = args[1];
    return admissionModule.createSqliteWorkerOperationAdmission(...args);
  };
  const module = { createSqliteWorkerOperationAdmission: create };
  const spy = probe.admission(module, (request, grant, originalAdmit) => {
    expect(originalAdmit).toBe(admit);
    events.push("intercept");
    originalAdmit(request, grant);
    events.push("after");
  });
  const admit = vi.fn<Parameters<typeof create>[0]>((request, grant) => {
    expect(request).toEqual({ stage: "transaction", facts: "synthetic facts" });
    events.push("admit");
    if (refuse) {
      throw failure;
    }
    expect(grant(() => events.push("grant"))).toBe(true);
  });
  const attachment = { fixture: "synthetic attachment" };
  const admission = module.createSqliteWorkerOperationAdmission(admit, attachment);
  try {
    expect(receiveMessageOnPort(admission.port)?.message).toEqual({
      kind: "sqlite-operation-attachment",
      value: attachment,
    });
    const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    admission.port.postMessage(
      { stage: "transaction", facts: "synthetic facts", decision: decision.buffer },
      [],
    );
    admission.service();
    expect(events).toEqual(
      refuse ? ["intercept", "admit"] : ["intercept", "admit", "grant", "after"],
    );
    expect(admission.failure).toBe(refuse ? failure : undefined);
    expect(Atomics.load(decision, 0)).toBe(refuse ? 2 : 1);
    expect(admit).toHaveBeenCalledOnce();
    expect(receivedAttachment).toBe(attachment);
  } finally {
    admission.finish();
    spy.mockRestore();
  }
  expect(module.createSqliteWorkerOperationAdmission).toBe(create);
});

it.each([false, true])(
  "preserves command scope, arguments and one-shot interception (%s)",
  (once) => {
    const local = new AsyncLocalStorage<string>();
    const result = Promise.resolve(undefined);
    const execute = vi.fn<DomainScope["execute"]>().mockReturnValue(result);
    const scope = { execute };
    const receivedRun = vi.fn();
    function run<T>(
      context: OpenClawStateWorkerContext,
      operation: (scope: DomainScope) => Promise<T>,
      options?: OpenClawStateWorkerOperationOptions,
    ): Promise<T> {
      receivedRun(context, options);
      return operation(scope);
    }
    const fallback = once
      ? <T>(_context: OpenClawStateWorkerContext, operation: (scope: DomainScope) => Promise<T>) =>
          operation(scope)
      : run;
    const module = { runOpenClawStateWorkerOperation: fallback };
    const context: OpenClawStateWorkerContext = {
      environment: { OPENCLAW_STATE_DIR: "/synthetic" },
      admission: {
        databasePath: "/synthetic/state.db",
        coordinationKey: "synthetic",
        identity: { key: "synthetic", canonicalPath: "/synthetic/state.db" },
        assertCurrent: vi.fn(),
      },
    };
    const command = { type: "deviceAuth.prepare", input: undefined } as const;
    const executeOptions = { signal: new AbortController().signal };
    const runOptions = { existingOnly: true };
    const intercepted = vi.fn();
    const spy = probe.command(
      module,
      (received, options, originalScope, originalContext) => {
        intercepted();
        expect(local.getStore()).toBe("caller");
        expect(originalScope).toBe(scope);
        expect(originalContext).toBe(context);
        expect(received).toBe(command);
        expect(options).toBe(executeOptions);
        return originalScope.execute(received, options);
      },
      once ? { once, original: run } : {},
    );
    const operation = (active: DomainScope) => active.execute(command, executeOptions);
    local.run("caller", () => {
      expect(module.runOpenClawStateWorkerOperation(context, operation, runOptions)).toBe(result);
      expect(module.runOpenClawStateWorkerOperation(context, operation, runOptions)).toBe(result);
    });
    expect(intercepted).toHaveBeenCalledTimes(once ? 1 : 2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(receivedRun).toHaveBeenCalledTimes(once ? 1 : 2);
    expect(execute.mock.contexts[0]).toBe(scope);
    expect(receivedRun.mock.calls[0]?.[0]).toBe(context);
    expect(receivedRun.mock.calls[0]?.[1]).toBe(runOptions);
    spy.mockRestore();
    expect(module.runOpenClawStateWorkerOperation).toBe(fallback);
  },
);
