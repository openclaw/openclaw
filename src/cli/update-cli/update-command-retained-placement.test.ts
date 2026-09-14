import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import {
  withGatewayServiceOperationLock,
  withSystemdServiceReadBinding,
} from "../../daemon/service-operation-lock.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceUpdateAuthority,
} from "../../daemon/service-update-authority.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

// Changed-base composition only. The actual scopes, dispatch and read lifetime run;
// external file/lease owners and the native command are inert. No custody proof.
vi.mock("../../infra/file-lock.js", () => ({
  withFileLock: async (_file: string, _options: unknown, operation: () => Promise<unknown>) =>
    operation(),
}));
vi.mock("../../infra/update-managed-service-handoff-lease.js", () => ({
  createManagedHandoffLeaseStore: () => ({ assertSourceUnborrowed() {} }),
}));
vi.mock("../../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => "/inert-native-placement",
}));
vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: () => {
    throw new Error("Unexpected unbound native runner in inert composition check");
  },
}));
afterEach(() => vi.restoreAllMocks());

describe("current native placement", () => {
  it.each(["commandRun", "retainedRecovery", "retainedService", "sealedRuntime"] as const)(
    "keeps %s source and packaged entrypoints resolvable together",
    (key) => {
      const entry = updateExecutorNativeEntrypoints[key];
      const source = resolveRuntimeWorkerUrl(entry);
      expect(fs.existsSync(fileURLToPath(source))).toBe(true);
      expect(source.pathname).toMatch(/\.[jt]s$/);
      const packaged = resolveRuntimeWorkerUrl({ ...entry, root: "/unexecuted-retained-package" });
      expect(fileURLToPath(packaged)).toBe(
        path.join("/unexecuted-retained-package", "dist", entry.distWorkerPath),
      );
    },
  );

  it.each([false, true])(
    "joins current retained-read disposal inside native authority, disposal failure=%s",
    async (failClose) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const closing = createDeferred();
      const release = createDeferred();
      const original = new Error("current read operation failed");
      const cleanup = new Error("current binding disposal failed");
      const env = { HOME: "/inert-native-home", OPENCLAW_SYSTEMD_UNIT: "retained.service" };
      const binding = {
        unit: "retained.service",
        managerUid: 1000,
        destination: ":1.0",
        verify: vi.fn(() => assertGatewayServiceUpdateCurrent()),
        query: vi.fn(async () => []),
        close: vi.fn(async () => {
          assertGatewayServiceUpdateCurrent();
          closing.resolve();
          await release.promise;
          if (failClose) {
            throw cleanup;
          }
        }),
      };
      const create = vi.fn(async () => binding);
      const native = vi.fn(async () => ({
        stdout: "current string output",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit" as const,
      }));
      let settled = false;
      const result = withGatewayServiceUpdateAuthority(
        () => undefined,
        () =>
          withGatewayServiceOperationLock(env, async () => {
            await withSystemdServiceReadBinding(env, create, async (selected) => {
              expect(selected).toBe(binding);
              expect(await execFileUtf8("inert-current-command", [], { env })).toMatchObject({
                stdout: "current string output",
                code: 0,
              });
            });
            if (failClose) {
              throw original;
            }
            return "current scope completed";
          }),
        native,
      ).then(
        (value) => {
          settled = true;
          return { value, error: undefined };
        },
        (error: unknown) => {
          settled = true;
          return { value: undefined, error };
        },
      );
      await closing.promise;
      expect(settled).toBe(false);
      expect(native).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledOnce();
      expect(binding.verify).toHaveBeenCalledOnce();
      release.resolve();
      const outcome = await result;
      if (failClose) {
        expect(outcome.error).toBeInstanceOf(AggregateError);
        expect(outcome.error).toMatchObject({ errors: [original, cleanup] });
      } else {
        expect(outcome).toEqual({ value: "current scope completed", error: undefined });
      }
      expect(binding.close).toHaveBeenCalledOnce();
      expect(binding.query).not.toHaveBeenCalled();
    },
  );
});
