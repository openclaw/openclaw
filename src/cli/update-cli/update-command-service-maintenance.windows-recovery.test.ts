import "./update-command-service-maintenance.test-support.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import * as schtasksExec from "../../daemon/schtasks-exec.js";
import type { GatewayService } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { waitForSignalExitBarriers } from "../signal-exit-barrier.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  gatewayCommand,
  maintenanceDefaults,
  commandResult,
} from "./update-command-service-fixtures.test-support.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import * as windowsRecovery from "./update-command-windows-task.js";

const { mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

function windowsService(home: string, overrides: Partial<GatewayService> = {}) {
  const service = createMockGatewayService({
    readCommand: async () => ({
      ...gatewayCommand(home),
      sourcePath: path.join(home, "gateway.cmd"),
    }),
    readRuntime: async () => ({ status: "running" }),
    isLoaded: async () => true,
    ...overrides,
  });
  mocks.service.mockReturnValue(service);
  return service;
}

function mutableTask(
  onQuery: () => void,
  onChange: (action: "/ENABLE" | "/DISABLE") => ReturnType<typeof commandResult> = () =>
    commandResult(),
) {
  const task = { enabled: true, mutations: [] as string[] };
  vi.spyOn(schtasksExec, "execSchtasks").mockImplementation(async (args) => {
    if (args[0] === "/Query") {
      onQuery();
      return commandResult(`<Task><Settings><Enabled>${task.enabled}</Enabled></Settings></Task>`);
    }
    const action = args.at(-1);
    if (args[0] !== "/Change" || (action !== "/ENABLE" && action !== "/DISABLE")) {
      throw new Error("Unexpected Scheduled Task mutation");
    }
    task.mutations.push(action);
    task.enabled = action === "/ENABLE";
    return onChange(action);
  });
  return task;
}

it.each(["ERROR: Access is denied.", "HRESULT 0x80070005"])(
  "reports elevation guidance without restoring a denied task disable: %s",
  (detail) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("win32");
      const task = vi
        .spyOn(schtasksExec, "execSchtasks")
        .mockImplementation(async (args) =>
          args[0] === "/Query"
            ? commandResult("<Task><Settings><Enabled>true</Enabled></Settings></Task>")
            : commandResult("", 1, detail),
        );
      const service = windowsService(home);
      const failure = await maybeStopManagedServiceBeforeMutableUpdate(maintenanceDefaults).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        failureFacts: [expect.objectContaining({ code: "windows-task-elevation-required" })],
        message: expect.stringContaining("elevated terminal (Run as administrator)"),
      });
      expect(String(failure)).toContain("npm i -g 'openclaw@<target>' --allow-scripts=openclaw");
      expect(String(failure)).toContain("openclaw doctor --fix");
      expect(String(failure)).toContain("openclaw gateway restart");
      expect(
        task.mock.calls.map(([args]) => (args[0] === "/Change" ? args.at(-1) : args[0])),
      ).toEqual(["/Query", "/DISABLE"]);
      expect(service.stop).not.toHaveBeenCalled();
    }),
);

it.each([
  ["disable", [], true],
  ["restore", ["/DISABLE"], false],
  ["compensation", ["/DISABLE", "/ENABLE"], true],
  ["never", ["/DISABLE", "/ENABLE", "/DISABLE"], false],
  ["stop-return", ["/DISABLE"], false],
  ["stop-reject", ["/DISABLE"], false],
] as const)(
  "retains caller authority when Windows task recovery loses its owner before %s",
  (lostBefore, mutations, enabled) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("win32");
      const lostDuringStop = lostBefore === "stop-return" || lostBefore === "stop-reject";
      const authorityLost = new Error("Repair continuation no longer owns this task");
      const stopFailure = new Error("Native stop failed after mutation");
      let partialStop: PreManagedServiceStop | undefined;
      let privateRecovery: windowsRecovery.WindowsTaskAutoStartRecovery | undefined;
      const readListeners = () =>
        ["SIGINT", "SIGTERM", "SIGBREAK"].map((signal) => process.listeners(signal));
      let ownedListeners: ReturnType<typeof readListeners> = [];
      const createRecovery = windowsRecovery.createWindowsTaskAutoStartRecovery;
      vi.spyOn(windowsRecovery, "createWindowsTaskAutoStartRecovery").mockImplementation(
        (params) => {
          const before = readListeners();
          privateRecovery = createRecovery(params);
          ownedListeners = readListeners().map((listeners, index) =>
            listeners.filter((listener) => !before[index]?.includes(listener)),
          );
          return privateRecovery;
        },
      );
      let current = true;
      let revokeDuringInspection = false;
      const task = mutableTask(() => {
        if (lostBefore === "disable") {
          current = false;
        }
      });
      windowsService(home, {
        readRuntime: async () => {
          if (revokeDuringInspection) {
            current = false;
          }
          return { status: "running" };
        },
        stop: async (args) => {
          if (lostDuringStop) {
            args.onMutation?.({ mode: "schtasks-stop" });
            current = false;
            if (lostBefore === "stop-reject") {
              throw stopFailure;
            }
          }
        },
      });
      let stopped: PreManagedServiceStop | undefined;
      let failure: unknown;
      try {
        try {
          stopped = await maybeStopManagedServiceBeforeMutableUpdate({
            ...maintenanceDefaults,
            shouldRestart: lostBefore !== "disable",
            onStopped: (state) => {
              partialStop = state;
            },
            assertCurrent: () => {
              if (!current) {
                throw authorityLost;
              }
            },
          });
          const recovery = expectDefined(
            stopped.windowsTaskAutoStartRecovery,
            "Missing Windows task recovery",
          );
          revokeDuringInspection = lostBefore === "restore";
          await recovery.restore();
          revokeDuringInspection = lostBefore === "compensation";
          await recovery.complete(false);
        } catch (error) {
          failure = error;
        }
        expect(task).toEqual({ mutations, enabled });
        if (lostDuringStop) {
          expect(stopped).toBeUndefined();
          expect(partialStop?.stopped).toBe(true);
          expect(partialStop).not.toHaveProperty("windowsTaskAutoStartRecovery");
          const errors = collectNestedErrorCandidates(failure);
          expect(errors).toContain(authorityLost);
          if (lostBefore === "stop-reject") {
            expect(errors).toContain(stopFailure);
          }
          expect(ownedListeners.flat().length).toBeGreaterThan(0);
          const remaining = readListeners();
          expect(
            ownedListeners.map((listeners, index) =>
              listeners.filter((listener) => remaining[index]?.includes(listener)),
            ),
          ).toEqual([[], [], []]);
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
        await (stopped?.windowsTaskAutoStartRecovery ?? privateRecovery)?.complete(
          Boolean(stopped),
        );
      }
    }),
);

it.each(["before-disable", "after-disable"] as const)(
  "preserves Windows task compensation authority when interrupted %s",
  (interruption) =>
    withServiceHome(async (home) => {
      const root = process.cwd();
      const run: NonNullable<Parameters<typeof createUpdateCommandExecutionGuards>[0]["run"]> = {
        runId: randomUUID(),
        env: { HOME: home },
      };
      const task = mutableTask(
        () => {
          if (interruption === "before-disable") {
            run.interrupted = true;
          }
        },
        (action) => {
          if (action === "/DISABLE") {
            run.interrupted = true;
            return commandResult("", 124, "disable failed after commit");
          }
          return commandResult();
        },
      );
      const service = windowsService(home);
      const failure = await withUpdateCommandExecutor(run.runId, async (executor) => {
        const guards = createUpdateCommandExecutionGuards({ run }, root);
        guards.admitExecutor(await executor.enter(root));
        const platform = mockProcessPlatform("win32");
        try {
          await maybeStopManagedServiceBeforeMutableUpdate({
            ...maintenanceDefaults,
            root,
            shouldRestart: false,
            updateRun: run,
            recordPhase: guards.recordPhase,
            assertCurrent: guards.assertCurrent,
          });
        } finally {
          platform.mockRestore();
        }
      }).catch((error: unknown) => error);
      expect(task).toEqual({
        mutations: interruption === "before-disable" ? [] : ["/DISABLE", "/ENABLE"],
        enabled: true,
      });
      expect(service.stop).not.toHaveBeenCalled();
      expect(String(failure)).toMatch(
        interruption === "before-disable"
          ? /requester-revoked/
          : /schtasks disable failed: disable failed after commit/,
      );
    }),
);
