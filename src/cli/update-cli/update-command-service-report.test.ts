// Install the native service fixtures before loading the maintenance owner.
import "./update-command-service-maintenance.test-support.js";
import { expect, it } from "vitest";
import {
  ServiceInspectionError,
  type ServiceInspectionDiagnostic,
} from "../../daemon/service-inspection-error.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { prepareUpdateServiceResult } from "./update-command-result.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const { mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

it.each([
  [{ kind: "native", exitCode: 1, hresult: -2147024891 }, "HRESULT 0x80070005"],
  [{ kind: "invalid-response", stage: "json" }, "invalid JSON"],
  [{ kind: "invalid-response", stage: "access-facts" }, "invalid access facts"],
  [{ kind: "invalid-response", stage: "task-snapshot" }, "invalid task snapshot"],
] satisfies Array<[ServiceInspectionDiagnostic, string]>)(
  "keeps Task Scheduler diagnostics in bounded failure reports: %j",
  (diagnostic, detail) =>
    withServiceHome(async () => {
      mockProcessPlatform("win32");
      const service = createMockGatewayService({
        readCommand: async () => {
          throw new ServiceInspectionError("windows-task-inspection-failed", diagnostic);
        },
      });
      mocks.service.mockReturnValue(service);
      const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        phase: "inspect",
        jsonMode: true,
      });
      const result: UpdateRunResult = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
      prepareUpdateServiceResult({
        result,
        opts: { json: true },
        root: process.cwd(),
        shouldRestart: true,
        coreAlreadyCurrent: false,
        preManagedServiceStop: inspected,
      });
      expect(result.steps[0]?.failureFacts?.[0]?.message).toContain(detail);
      expect(result.steps[0]?.failureFacts?.[0]?.message?.length).toBeLessThanOrEqual(200);
      const report = renderUpdateRunReport(updateRunReportInputFromResult(result));
      expect(report.markdown).toContain(detail);
      expect(inspected.serviceMutationAllowed).toBe(false);
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
    }),
);
