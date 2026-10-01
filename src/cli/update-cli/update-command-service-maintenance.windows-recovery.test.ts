// Reuse the maintained native service fixture and the actual Windows recovery owner.
import "./update-command-service-maintenance.test-support.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as schtasksExec from "../../daemon/schtasks-exec.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { waitForSignalExitBarriers } from "../signal-exit-barrier.js";
import type { UpdateCommandOptions } from "./shared.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import * as windowsRecovery from "./update-command-windows-task.js";

const { mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

it.each(["disable", "restore", "compensation", "never", "stop-return", "stop-reject"] as const)(
  "retains caller authority when Windows task recovery loses its owner before %s",
  (lostBefore) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("win32");
      const lostDuringStop = lostBefore === "stop-return" || lostBefore === "stop-reject";
      const authorityLost = new Error("Repair continuation no longer owns this task");
      const stopFailure = new Error("Native stop failed after mutation");
      let partialStop: PreManagedServiceStop | undefined;
      let privateRecovery:
        | ReturnType<typeof windowsRecovery.createWindowsTaskAutoStartRecovery>
        | undefined;
      const ownedListeners = new Map<string, ReturnType<typeof process.listeners>>();
      const createRecovery = windowsRecovery.createWindowsTaskAutoStartRecovery;
      vi.spyOn(windowsRecovery, "createWindowsTaskAutoStartRecovery").mockImplementation(
        (params) => {
          const signals = ["SIGINT", "SIGTERM", "SIGBREAK"];
          const previous = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
          privateRecovery = createRecovery(params);
          for (const signal of signals) {
            ownedListeners.set(
              signal,
              process
                .listeners(signal)
                .filter((listener) => !previous.get(signal)?.includes(listener)),
            );
          }
          return privateRecovery;
        },
      );
      let current = true;
      let revokeDuringInspection = false;
      let enabled = true;
      const mutations: string[] = [];
      vi.spyOn(schtasksExec, "execSchtasks").mockImplementation(async (args) => {
        if (args[0] === "/Query") {
          if (lostBefore === "disable") {
            current = false;
          }
          return {
            code: 0,
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
            stderr: "",
          };
        }
        expect(args[0]).toBe("/Change");
        const action = args.at(-1);
        if (action !== "/ENABLE" && action !== "/DISABLE") {
          throw new Error("Unexpected Scheduled Task mutation");
        }
        mutations.push(action);
        enabled = action === "/ENABLE";
        return { code: 0, stdout: "", stderr: "" };
      });
      mocks.service.mockReturnValue(
        createMockGatewayService({
          readCommand: async () => ({
            programArguments: [
              process.execPath,
              path.join(process.cwd(), "openclaw.mjs"),
              "gateway",
            ],
            environment: { HOME: home },
            sourcePath: path.join(home, "gateway.cmd"),
          }),
          readRuntime: async () => {
            if (revokeDuringInspection) {
              current = false;
            }
            return { status: "running" };
          },
          isLoaded: async () => true,
          stop: async (args) => {
            if (lostDuringStop) {
              args.onMutation?.({ mode: "schtasks-stop" });
              current = false;
              if (lostBefore === "stop-reject") {
                throw stopFailure;
              }
            }
          },
        }),
      );
      let stopped: PreManagedServiceStop | undefined;
      let failure: unknown;
      try {
        try {
          stopped = await maybeStopManagedServiceBeforeMutableUpdate({
            root: process.cwd(),
            updateInstallKind: "package",
            shouldRestart: lostBefore !== "disable",
            jsonMode: true,
            onStopped: (state) => {
              partialStop = state;
            },
            assertCurrent: () => {
              if (!current) {
                throw authorityLost;
              }
            },
          });
          const recovery = stopped.windowsTaskAutoStartRecovery;
          if (!recovery) {
            throw new Error("Missing Windows task recovery");
          }
          revokeDuringInspection = lostBefore === "restore";
          await recovery.restore();
          revokeDuringInspection = lostBefore === "compensation";
          await recovery.complete(false);
        } catch (error) {
          failure = error;
        }
        expect(mutations).toEqual(
          lostDuringStop
            ? ["/DISABLE"]
            : lostBefore === "disable"
              ? []
              : lostBefore === "restore"
                ? ["/DISABLE"]
                : lostBefore === "compensation"
                  ? ["/DISABLE", "/ENABLE"]
                  : ["/DISABLE", "/ENABLE", "/DISABLE"],
        );
        expect(enabled).toBe(lostBefore === "disable" || lostBefore === "compensation");
        if (lostDuringStop) {
          expect(stopped).toBeUndefined();
          expect(partialStop?.stopped).toBe(true);
          expect(partialStop).not.toHaveProperty("windowsTaskAutoStartRecovery");
          const errors = collectNestedErrorCandidates(failure);
          expect(errors).toContain(authorityLost);
          if (lostBefore === "stop-reject") {
            expect(errors).toContain(stopFailure);
          }
          expect([...ownedListeners.values()].flat().length).toBeGreaterThan(0);
          for (const [signal, listeners] of ownedListeners) {
            for (const listener of listeners) {
              expect(process.listeners(signal)).not.toContain(listener);
            }
          }
          await waitForSignalExitBarriers();
        }
        if (lostBefore === "never") {
          expect(failure).toBeUndefined();
        } else if (lostDuringStop) {
          expect(failure).toBeInstanceOf(AggregateError);
          expect(String(failure)).toContain("Update executor was lost during native preparation");
        } else {
          expect(String(failure)).toContain("Repair continuation no longer owns this task");
        }
      } finally {
        await stopped?.windowsTaskAutoStartRecovery?.complete();
        // A failing baseline must still retire the real private token after assertions.
        if (!stopped) {
          await privateRecovery?.complete(false);
        }
      }
    }),
);

it.each(["before-disable", "after-disable", "invocation-replaced"] as const)(
  "preserves Windows task compensation authority when interrupted %s",
  (interruption) =>
    withServiceHome(async (home) => {
      const root = process.cwd();
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId: randomUUID(),
        env: { HOME: home },
      };
      const opts: UpdateCommandOptions = { run };
      const mutations: string[] = [];
      let enabled = true;
      vi.spyOn(schtasksExec, "execSchtasks").mockImplementation(async (args) => {
        if (args[0] === "/Query") {
          if (interruption === "before-disable") {
            run.interrupted = true;
          }
          return {
            code: 0,
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
            stderr: "",
          };
        }
        const action = args.at(-1);
        if (args[0] !== "/Change" || (action !== "/ENABLE" && action !== "/DISABLE")) {
          throw new Error("Unexpected Scheduled Task mutation");
        }
        mutations.push(action);
        enabled = action === "/ENABLE";
        if (action === "/DISABLE") {
          run.interrupted = true;
          if (interruption === "invocation-replaced") {
            opts.run = { ...run };
          }
          return { code: 124, stdout: "", stderr: "disable failed after commit" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
          sourcePath: path.join(home, "gateway.cmd"),
        }),
        readRuntime: async () => ({ status: "running" }),
        isLoaded: async () => true,
      });
      mocks.service.mockReturnValue(service);
      let failure: unknown;
      try {
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          const guards = createUpdateCommandExecutionGuards(opts, root);
          guards.admitExecutor(await executor.enter(root));
          const platform = mockProcessPlatform("win32");
          try {
            await maybeStopManagedServiceBeforeMutableUpdate({
              root,
              updateInstallKind: "package",
              shouldRestart: false,
              jsonMode: true,
              updateRun: run,
              recordPhase: guards.recordPhase,
              assertCurrent: guards.assertCurrent,
            });
          } finally {
            platform.mockRestore();
          }
        });
      } catch (error) {
        failure = error;
      }
      expect(mutations).toEqual(
        interruption === "before-disable"
          ? []
          : interruption === "invocation-replaced"
            ? ["/DISABLE"]
            : ["/DISABLE", "/ENABLE"],
      );
      expect(enabled).toBe(interruption !== "invocation-replaced");
      expect(service.stop).not.toHaveBeenCalled();
      expect(String(failure)).toMatch(
        interruption === "before-disable"
          ? /requester-revoked/
          : interruption === "invocation-replaced"
            ? /requester-revoked/
            : /schtasks disable failed: disable failed after commit/,
      );
    }),
);
