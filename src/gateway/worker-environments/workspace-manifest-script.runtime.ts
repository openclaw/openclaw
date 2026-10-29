import { requestGitWorkerCommand } from "../../infra/git-worker-context.js";
import type { WorkspaceManifestComputationOperations } from "./workspace-manifest-computation.js";
import { runWorkspaceManifestProgram } from "./workspace-manifest-script.generated.mjs";

export async function captureNodeWorkspaceManifestImpl(
  input: WorkspaceManifestComputationOperations["workspace.manifest.remote-capture"]["input"],
  assertCurrent: () => void = () => {},
): Promise<string> {
  let stdout = "";
  await runWorkspaceManifestProgram(
    {
      argv: [process.execPath, ...input.argv],
      env: { HOME: input.home },
      pid: process.pid,
      platform: process.platform,
      stdout: {
        write: (value: string) => {
          if (
            Buffer.byteLength(stdout) + Buffer.byteLength(value) >
            input.maxHashMemoBytes + 4096
          ) {
            throw new Error("Node workspace manifest output exceeds its byte limit");
          }
          stdout += value;
        },
      },
    },
    () => input.memo ?? "",
    assertCurrent,
    async (root: string, args: string[], maxOutputBytes: number) => {
      const result = await requestGitWorkerCommand({
        type: "git.buffer",
        input: { cwd: root, args, options: { maxOutputBytes, timeoutMs: 10 * 60_000 } },
      });
      if (result.termination !== "exit" || result.code !== 0) {
        throw new Error("Worker workspace Git inventory failed");
      }
      return Buffer.from(result.stdout);
    },
    input.maxHashMemoBytes,
  );
  return stdout;
}
