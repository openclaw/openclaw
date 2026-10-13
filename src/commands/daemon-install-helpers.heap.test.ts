import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { auditGatewayInstallPreservation } from "../daemon/service-audit-preservation.js";
import type { ServiceDefinitionDrift } from "../daemon/service-audit-types.js";

vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  resolveSystemNodeInfo: vi.fn(async () => ({
    path: "/opt/node",
    version: "24.21.0",
    status: "supported",
  })),
}));

import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";

describe("buildGatewayInstallPlan heap preservation", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["canonical", "operator controls", "unrelated native flag"])(
    "preserves effective heap controls when adopting Bun from a Node plan: %s",
    async (kind) => {
      const isolatedHome = tempDirs.make("oc-plan-heap-");
      const physical = vi.spyOn(os, "totalmem").mockReturnValue(32 * 1024 ** 3);
      const constrained = vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
      try {
        const entry = path.join(isolatedHome, "dist", "index.js");
        fs.mkdirSync(path.dirname(entry));
        fs.writeFileSync(entry, "");
        const nodePath = path.join(isolatedHome, "node.exe");
        const options = {
          env: { HOME: isolatedHome },
          authStore: { version: 1 as const, profiles: {} },
          port: 18789,
          platform: "win32" as const,
          serviceCli: { executable: nodePath, entrypoint: entry },
          runtimeExplicit: true,
        };
        const operator = kind === "operator controls";
        const nodePlan = await buildGatewayInstallPlan({
          ...options,
          runtime: "node",
          runtimePath: nodePath,
          ...(operator
            ? {
                existingCommand: {
                  programArguments: [
                    nodePath,
                    "--max_old_space_size",
                    "6144",
                    "--max-heap-size=12288",
                    entry,
                    "gateway",
                  ],
                  environment: {
                    NODE_OPTIONS:
                      "--max-old-space-size=1024 --max-heap-size=4096 --max-old-space-size-percentage=25",
                  },
                },
              }
            : {}),
        });
        const current = {
          programArguments: nodePlan.programArguments,
          environment: Object.fromEntries(
            Object.entries(nodePlan.environment).filter(
              (item): item is [string, string] => typeof item[1] === "string",
            ),
          ),
        };
        if (kind === "unrelated native flag") {
          current.programArguments.splice(1, 0, "--inspect=127.0.0.1:9229");
        }
        const plan = await buildGatewayInstallPlan({
          ...options,
          runtime: "bun",
          runtimePath: path.join(isolatedHome, "bun.exe"),
          existingCommand: current,
          existingEnvironment: current.environment,
        });
        expect(plan.environment.NODE_OPTIONS).toBe(
          operator
            ? "--max-old-space-size=6144 --max-heap-size=12288 --max-old-space-size-percentage=25"
            : "--max-old-space-size=8192",
        );
        expect(plan.programArguments).toEqual([
          path.join(isolatedHome, "bun.exe"),
          "--no-install",
          entry,
          "gateway",
          "--port",
          "18789",
        ]);
        const findings: ServiceDefinitionDrift[] = [];
        auditGatewayInstallPreservation(current, plan, "win32", findings);
        expect(findings.map(({ key }) => key)).toEqual(
          kind === "unrelated native flag" ? ["ProgramArguments"] : [],
        );
        if (!operator) {
          expect(current.environment.NODE_OPTIONS).toBe("");
        }
      } finally {
        physical.mockRestore();
        constrained.mockRestore();
      }
    },
  );
});
