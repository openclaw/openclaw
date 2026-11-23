import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, type Mock } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
} from "./update-command-post-update.test-support.js";

export function registerNodeRestartNoticeTests(
  makeHome: () => string,
  mocks: {
    printResult: Mock;
    nodeCommand: Mock<GatewayService["readCommand"]>;
    nodeRuntime: Mock<GatewayService["readRuntime"]>;
    nodeRestart: Mock<GatewayService["restart"]>;
  },
) {
  it.each(["running", "stopped", "foreign"] as const)(
    "reports node restart guidance only for a running node using the replaced package: %s",
    async (state) => {
      const identity = createManagedServiceIdentityFixture(makeHome());
      try {
        const packageRoot = path.join(identity.home, "package");
        const foreignRoot = path.join(identity.home, "other-package");
        for (const root of [packageRoot, foreignRoot]) {
          await fs.mkdir(path.join(root, "dist"), { recursive: true });
          await fs.writeFile(
            path.join(root, "package.json"),
            JSON.stringify({ name: "openclaw", version: "1.0.1" }),
          );
          await fs.writeFile(path.join(root, "dist/index.js"), "");
        }
        mocks.nodeCommand.mockResolvedValue({
          programArguments: [
            process.execPath,
            path.join(state === "foreign" ? foreignRoot : packageRoot, "dist/index.js"),
            "node",
            "run",
          ],
          environment: { OPENCLAW_SERVICE_KIND: "node" },
        });
        mocks.nodeRuntime.mockResolvedValue({
          status: state === "stopped" ? "stopped" : "running",
          pid: 5151,
        });
        const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(identity.home, "state") };
        const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
        await finishSuccessfulPackageSwitch(
          { packageRoot, run, json: true },
          {
            preManagedServiceStop: {
              stopped: false,
              inspected: true,
              runtimeInspected: true,
              running: false,
              serviceMutationAllowed: false,
              serviceUpdateVerdict: { kind: "absent" },
              serviceMutationSkipMessage:
                "Gateway restart skipped: no Gateway service or listener is running.",
            },
          },
        );
        const reported = mocks.printResult.mock.lastCall?.[0];
        expect(reported.status).toBe("ok");
        const notice = getUpdateRun(run.runId, { env })?.steps.find(
          ({ step }) => step === "warning:node-service-inspection",
        );
        if (state === "running") {
          expect(notice?.detail).toContain("Node service is still running (PID 5151)");
          expect(notice?.detail).toContain("When the node is idle");
          expect(notice?.detail).toContain("openclaw node restart");
          expect(reported.steps).toContainEqual(
            expect.objectContaining({
              name: "node-service-inspection",
              warnings: [notice?.detail],
            }),
          );
        } else {
          expect(notice).toBeUndefined();
        }
        expect(mocks.nodeRestart).not.toHaveBeenCalled();
      } finally {
        identity.restore();
      }
    },
  );
}
