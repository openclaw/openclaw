import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";
import * as logger from "../logger.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

type WorkerPermissionFixture = {
  setup: (options: {
    inferencePlans: Array<
      | "tool"
      | "safe-tool"
      | "text"
      | { args: Record<string, unknown>; toolCallId: string; toolName: string }
    >;
    execApprovals?: ExecApprovalsFile;
  }) => Promise<{
    gateway: { inferenceRequests: WorkerInferenceStartParams[]; methods: string[] };
    workspaceDir: string;
    launch: WorkerLaunchDescriptor;
  }>;
};

export function registerWorkerPermissionTests({ setup }: WorkerPermissionFixture) {
  it.each([
    {
      mode: "read-only" as const,
      omittedTools: ["write", "edit", "apply_patch"],
      denial: /host=gateway security=deny/u,
    },
    {
      mode: "guarded" as const,
      omittedTools: [],
      denial:
        /approval_required.*worker guarded permission mode.*run this command locally.*interactive approval.*administrator.*clear the session permission mode/isu,
    },
    {
      mode: "workspace" as const,
      omittedTools: [],
      denial:
        /approval_required.*worker workspace permission mode.*run this command locally.*interactive approval.*administrator.*clear the session permission mode/isu,
    },
    { mode: "full" as const, omittedTools: [], denial: null },
  ])("applies the $mode worker permission clamp", async ({ mode, omittedTools, denial }) => {
    const { gateway, workspaceDir, launch } = await setup({
      inferencePlans: ["tool", "text"],
      ...(mode === "full"
        ? {
            execApprovals: {
              version: 1,
              defaults: { security: "full", ask: "always" },
              agents: {},
            },
          }
        : {}),
    });
    launch.assignment.permissionMode = mode;
    launch.assignment.workerContainmentRoot = workspaceDir;

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    const toolNames = gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name) ?? [];
    for (const toolName of omittedTools) {
      expect(toolNames).not.toContain(toolName);
    }
    const toolResult = JSON.stringify(
      gateway.inferenceRequests[1]?.context.messages.find(
        (message) => message.role === "toolResult",
      ),
    );
    if (denial) {
      expect(toolResult).toMatch(denial);
      await expect(
        readFile(path.join(workspaceDir, "local-proof.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(readFile(path.join(workspaceDir, "local-proof.txt"), "utf8")).resolves.toBe(
        "worker-local",
      );
      expect(toolResult).not.toMatch(/approval_required|approval-pending/iu);
      expect(gateway.methods.some((method) => method.includes("approval"))).toBe(false);
    }
  });

  it.each(["guarded", "workspace"] as const)(
    "denies default safe bins under the %s worker permission policy",
    async (mode) => {
      const { gateway, workspaceDir, launch } = await setup({
        inferencePlans: ["safe-tool", "text"],
      });
      launch.assignment.permissionMode = mode;
      launch.assignment.workerContainmentRoot = workspaceDir;

      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

      const toolResult = JSON.stringify(
        gateway.inferenceRequests[1]?.context.messages.find(
          (message) => message.role === "toolResult",
        ),
      );
      expect(toolResult).toContain("approval_required");
    },
  );

  it.each([
    {
      policy: "default",
      permissionMode: undefined,
      operatorHint: "workspace-contained by default on worker placements",
    },
    {
      policy: "guarded",
      permissionMode: "guarded" as const,
      operatorHint: "workspace-contained by this session's permission mode",
    },
  ])(
    "reports the $policy worker apply_patch containment owner without changing the rejection",
    async ({ permissionMode, operatorHint }) => {
      const { gateway, workspaceDir, launch } = await setup({
        inferencePlans: [
          {
            toolCallId: "outside-patch",
            toolName: "apply_patch",
            args: {
              input: [
                "*** Begin Patch",
                "*** Update File: ../outside.txt",
                "@@",
                "-outside-before",
                "+outside-after",
                "*** End Patch",
              ].join("\n"),
            },
          },
          "text",
        ],
      });
      const contained = path.join(workspaceDir, "contained");
      const outside = path.join(workspaceDir, "outside.txt");
      await mkdir(contained);
      await writeFile(outside, "outside-before\n", { mode: 0o640 });
      const originalMode = (await stat(outside)).mode;
      launch.assignment.workspaceDir = contained;
      launch.assignment.workerContainmentRoot = contained;
      if (permissionMode) {
        launch.assignment.permissionMode = permissionMode;
      }

      const logError = vi.spyOn(logger, "logError").mockImplementation(() => {});
      try {
        await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

        const failure = {
          status: "error",
          tool: "apply_patch",
          error: `Path escapes sandbox root (${await realpath(contained)}): ../outside.txt`,
        };
        const toolResult = gateway.inferenceRequests[1]?.context.messages.find(
          (message) => message.role === "toolResult",
        );
        expect(toolResult).toMatchObject({ toolName: "apply_patch", details: failure });
        expect(toolResult?.content).toEqual([
          { type: "text", text: JSON.stringify(failure, null, 2) },
        ]);
        expect(JSON.stringify(toolResult)).not.toContain(operatorHint);
        const operatorLogs = logError.mock.calls
          .map(([message]) => message)
          .filter((message) => message.startsWith("[tools] apply_patch failed:"));
        expect(operatorLogs).toHaveLength(1);
        expect(operatorLogs[0]).toContain(operatorHint);
        expect(operatorLogs[0]).not.toContain("workspace-contained by configuration");
        await expect(readFile(outside, "utf8")).resolves.toBe("outside-before\n");
        expect((await stat(outside)).mode).toBe(originalMode);
      } finally {
        logError.mockRestore();
      }
    },
  );
}
