import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { createWorkerRuntimeEnvironment, runWorkerDescriptor } from "./worker.runtime.js";
type GitHubFailureFixture = {
  sessionId: string;
  setup: (options?: { inferencePlans?: Array<"tool" | "text">; execCommand?: string }) => Promise<{
    gateway: { inferenceRequests: WorkerInferenceStartParams[] };
    launch: WorkerLaunchDescriptor;
  }>;
};
export function registerWorkerGitHubFailureTests({ setup, sessionId }: GitHubFailureFixture): void {
  it.skipIf(process.platform === "win32")(
    "keeps exec unbound and creates no GitHub profile without a turn identity",
    async () => {
      // Direct in-process fixtures bypass the node supervisor's sanitized child environment.
      vi.stubEnv("GH_CONFIG_DIR", undefined);
      vi.stubEnv("GH_TOKEN", undefined);
      vi.stubEnv("GITHUB_TOKEN", undefined);
      const { gateway, launch } = await setup({
        inferencePlans: ["tool", "text"],
        execCommand: 'printf "profile=%s\\n" "${GH_CONFIG_DIR-unset}"',
      });
      const environment = await createWorkerRuntimeEnvironment(sessionId);
      try {
        await expect(
          runWorkerDescriptor(launch, { environmentStateDir: environment.stateDir }),
        ).resolves.toMatchObject({ status: "completed" });

        const toolResult = gateway.inferenceRequests[1]?.context.messages.find(
          (message) => message.role === "toolResult" && message.toolName === "exec",
        );
        expect(toolResult).toMatchObject({
          isError: false,
          content: [{ type: "text", text: expect.stringContaining("profile=unset") }],
        });
        await expect(
          stat(path.join(environment.stateDir, "github-profiles")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await environment.close();
      }
    },
  );

  it("reports a GitHub profile write failure before running inference", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.github = {
      token: "worker-profile-write-fixture-token",
      login: "worker-fixture",
      branch: "openclaw/session-fixture",
    };
    const environment = await createWorkerRuntimeEnvironment(sessionId);
    try {
      // A file in the root's parent path cannot be repaired by removing github-profiles.
      const blockedStateDir = path.join(environment.stateDir, "obstruction");
      await writeFile(blockedStateDir, "obstruction");
      await expect(
        runWorkerDescriptor(launch, { environmentStateDir: blockedStateDir }),
      ).rejects.toThrow("Worker GitHub identity profile could not be written:");
      expect(gateway.inferenceRequests).toHaveLength(0);
    } finally {
      await environment.close();
    }
  });
}
