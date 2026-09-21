import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mutationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginStateKeyedStore } from "./plugin-state-store.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

describe("action-bound plugin state", () => {
  it.each(["dispatch", "transaction", "commit", "after commit"] as const)(
    "preserves renewal settlement when manager authority closes at %s",
    async (revocation) => {
      await withOpenClawTestState({ label: "plugin-state-renewal-authority" }, async (state) => {
        const store = createPluginStateKeyedStore<{ expiresAt: number }>("visitor-access", {
          namespace: "visitors",
          maxEntries: 10,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const email = "visitor@example.test";
        const previous = { expiresAt: Date.now() + 60_000 };
        const renewed = { expiresAt: previous.expiresAt + 60_000 };
        await store.register(email, previous);
        let managerCurrent = true;
        const assertInvocationCurrent = vi.fn();
        const action = store.withCurrent({
          assertCurrent: () => {
            assertInvocationCurrent();
            if (!managerCurrent) {
              throw new Error("Synthetic manager authority closed");
            }
          },
        });
        const stages: string[] = [];
        const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (admit) =>
            createAdmission((request, grant) => {
              stages.push(request.stage);
              if (request.stage === revocation) {
                managerCurrent = false;
              }
              admit(request, grant);
              if (request.stage === "commit" && revocation === "after commit") {
                managerCurrent = false;
              }
            }),
        );
        if (revocation === "dispatch") {
          const postMessageSpy = vi.spyOn(Worker.prototype, "postMessage");
          postMessageSpy.mockImplementationOnce(function (this: Worker, message, transferList) {
            const request = asOptionalRecord(message);
            if (
              request?.type === "execute" &&
              request.input instanceof Uint8Array &&
              asOptionalRecord(deserialize(request.input))?.type === "pluginState.register"
            ) {
              // The caller passed its pre-dispatch check; the write is now queued for SQLite.
              managerCurrent = false;
            }
            postMessageSpy.mockRestore();
            return this.postMessage(message, transferList);
          });
        }

        const writing = action.register(email, renewed);
        if (revocation === "after commit") {
          await expect(writing).resolves.toBeUndefined();
        } else {
          await expect(writing).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
        }
        expect(managerCurrent).toBe(false);
        expect(assertInvocationCurrent).toHaveBeenCalled();
        if (revocation !== "dispatch") {
          expect(stages).toEqual(
            revocation === "transaction" ? ["transaction"] : ["transaction", "commit"],
          );
        }
        expect(await store.lookup(email)).toEqual(
          revocation === "after commit" ? renewed : previous,
        );
      });
    },
  );

  it.each(["observe", "update conflict", "delete conflict"] as const)(
    "withholds a %s observation when authority closes after transaction admission",
    async (operation) => {
      await withOpenClawTestState(
        { label: "plugin-state-observation-authority" },
        async (state) => {
          const store = createPluginStateKeyedStore<string>("private-records", {
            namespace: "observations",
            maxEntries: 10,
            env: state.env,
          });
          await store.register("key", "before");
          const observed = await store.observe("key");
          await store.register("key", "private current value");
          let current = true;
          const action = store.withCurrent({
            assertCurrent: () => {
              if (!current) {
                throw new Error("Synthetic reader authority closed");
              }
            },
          });
          const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
          vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
            (admit) =>
              createAdmission((request, grant) => {
                admit(request, grant);
                if (request.stage === "commit") {
                  current = false;
                }
              }),
          );
          const reading =
            operation === "observe"
              ? action.observe("key")
              : action.compareAndApply("key", observed.comparison, {
                  operation: operation === "update conflict" ? "update" : "delete",
                  action: "keep",
                });
          await expect(reading).rejects.toThrow();
          expect(current).toBe(false);
          expect(await store.lookup("key")).toBe("private current value");
        },
      );
    },
  );

  it("keeps a bounded action view tied to its original plugin lifetime", async () => {
    await withOpenClawTestState({ label: "plugin-state-action-lifetime" }, async (state) => {
      let runtimeCurrent = true;
      const store = createPluginStateKeyedStore<string>(
        "visitor-access",
        {
          namespace: "visitors",
          maxEntries: 10,
          overflowPolicy: "reject-new",
          env: state.env,
        },
        () => {
          if (!runtimeCurrent) {
            throw new Error("Synthetic plugin lifetime closed");
          }
        },
      );
      const action = store.withCurrent({ assertCurrent: () => {} });
      await action.register("visitor@example.test", "original");
      const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
      vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (admit) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit") {
              runtimeCurrent = false;
            }
            admit(request, grant);
          }),
      );
      await expect(action.delete("visitor@example.test")).rejects.toMatchObject({
        code: "PLUGIN_STATE_WRITE_FAILED",
      });
      expect(await store.lookup("visitor@example.test")).toBe("original");
    });
  });
});
