import { describe, expect, it } from "vitest";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPluginLifecycleCommandLease } from "./plugin-lifecycle-command.js";

describe("plugin lifecycle command lease", () => {
  it("releases the lease before forwarding a runtime exit", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-command-exit" }, async () => {
      const exits: Array<{ code: number; resetStream: NodeJS.WriteStream | undefined }> = [];
      const runtime: RuntimeEnv = {
        log: () => undefined,
        error: () => undefined,
        exit: (code, options) => {
          exits.push({ code, resetStream: options?.resetStream });
          throw new ExitError(code);
        },
      };

      await expect(
        withPluginLifecycleCommandLease(runtime, async (deferredExitRuntime) => {
          deferredExitRuntime.exit(7, { resetStream: process.stderr });
          throw new Error("unreachable");
        }),
      ).rejects.toMatchObject({ code: 7 });
      expect(exits).toEqual([{ code: 7, resetStream: process.stderr }]);

      let acquired = false;
      await withPluginLifecycleLease({ waitMs: 0 }, async () => {
        acquired = true;
      });
      expect(acquired).toBe(true);
    });
  });
});
