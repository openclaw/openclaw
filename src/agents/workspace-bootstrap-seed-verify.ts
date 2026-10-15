import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { retryAsync } from "../infra/retry.js";
import { WorkspaceBootstrapSeedConflictError } from "./workspace-bootstrap-publish.js";
import { readWorkspaceFileWithGuards } from "./workspace-file-read.js";

export async function verifyExistingWorkspaceBootstrap(params: {
  bootstrapPath: string;
  workspaceDir: string;
  expectedContent: Buffer;
}): Promise<void> {
  const statExistingBootstrap = () =>
    fs.stat(params.bootstrapPath).catch((error: unknown) => {
      throw new WorkspaceBootstrapSeedConflictError(
        "Existing BOOTSTRAP.md could not be read safely.",
        { cause: error },
      );
    });
  await retryAsync(
    async () => {
      const statBefore = await statExistingBootstrap();
      const existing = await readWorkspaceFileWithGuards({
        filePath: params.bootstrapPath,
        workspaceDir: params.workspaceDir,
        useCache: false,
      });
      if (!existing.ok) {
        throw new WorkspaceBootstrapSeedConflictError(
          "Existing BOOTSTRAP.md could not be read safely.",
        );
      }
      if (!Buffer.from(existing.content, "utf8").equals(params.expectedContent)) {
        throw new WorkspaceBootstrapSeedConflictError(
          "Existing BOOTSTRAP.md differs from the consented Claw bootstrap.",
        );
      }
      await delay(20);
      const statAfter = await statExistingBootstrap();
      if (
        statBefore.size !== statAfter.size ||
        statBefore.mtimeMs !== statAfter.mtimeMs ||
        statAfter.size !== params.expectedContent.byteLength
      ) {
        throw new WorkspaceBootstrapSeedConflictError(
          "Existing BOOTSTRAP.md write has not stabilized.",
        );
      }
      const stable = await readWorkspaceFileWithGuards({
        filePath: params.bootstrapPath,
        workspaceDir: params.workspaceDir,
        useCache: false,
      });
      if (!stable.ok || !Buffer.from(stable.content, "utf8").equals(params.expectedContent)) {
        throw new WorkspaceBootstrapSeedConflictError(
          "Existing BOOTSTRAP.md differs from the consented Claw bootstrap.",
        );
      }
    },
    {
      attempts: 5,
      minDelayMs: 20,
      maxDelayMs: 80,
      shouldRetry: (error) => error instanceof WorkspaceBootstrapSeedConflictError,
    },
  );
}
