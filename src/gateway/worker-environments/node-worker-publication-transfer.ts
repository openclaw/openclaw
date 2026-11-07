import fs from "node:fs/promises";
import path from "node:path";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { NODE_WORKSPACE_EMPTY_MANIFEST_REF } from "../../worker/node-workspace-transfer-protocol.js";
import { readGitHubRepositoryPublicationMetadata } from "../github-repository-publication-snapshot.js";
import type { RepositoryPublicationIntegrationInput } from "../repository-publication-integration.js";
import { StaleWorkerBuildError } from "./admission.js";
import type { createNodeWorkspaceTransferCommand } from "./node-workspace-transfer-command.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { removeNodeWorkspaceUpload } from "./node-workspace-upload-reader.js";
import { captureWorkspaceSnapshot } from "./workspace-manifest-worker.js";

/** Transfer an immutable checkpoint through the existing tunnel owner, leaving editing custody intact. */
export async function prepareNodeWorkerPublicationIntegration(
  params: {
    environmentId: string;
    signal: AbortSignal;
    workspaceTransfer: NodeWorkspaceTransferService;
    supportsIntegration?: () => Promise<boolean>;
    transfer: ReturnType<typeof createNodeWorkspaceTransferCommand>;
  },
  input: RepositoryPublicationIntegrationInput,
) {
  input.assertCurrent();
  if (!(await params.supportsIntegration?.())) {
    throw new StaleWorkerBuildError();
  }
  input.assertCurrent();
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "publication-input-" },
    async ({ dir }) => {
      const history = input.history;
      const gitHistory =
        history?.gitPackPath &&
        !history.gitHistoryNote &&
        history.gitHistory?.descendsFromBase &&
        !history.gitHistory.unavailableReason
          ? history.gitHistory
          : undefined;
      let inputRoot = input.snapshotRoot;
      if (gitHistory) {
        inputRoot = path.join(dir, "input");
        await fs.cp(input.snapshotRoot, inputRoot, { recursive: true });
        await fs.copyFile(history!.gitPackPath!, path.join(inputRoot, "history.pack"));
      }
      const captured = await captureWorkspaceSnapshot({
        root: inputRoot,
        baseCommit: null,
        signal: params.signal,
      });
      input.assertCurrent();
      const download = params.workspaceTransfer.publishSnapshot(
        params.environmentId,
        { ...captured, root: inputRoot },
        input.assertCurrent,
        false,
      );
      let upload: string | undefined;
      let result: ReturnType<typeof params.workspaceTransfer.takeUpload> | undefined;
      try {
        upload = params.workspaceTransfer.prepareUpload(
          params.environmentId,
          NODE_WORKSPACE_EMPTY_MANIFEST_REF,
          input.assertCurrent,
        );
        await params.transfer(
          {
            direction: "publication",
            token: upload,
            inputToken: download,
            inputManifestRef: captured.manifestRef,
            inputDigest: input.snapshotDigest,
            sourceUrl: input.sourceUrl,
            targetUrl: input.targetUrl,
            targetCommit: input.targetCommit,
            gitToken: input.token,
            ...(gitHistory ? { checkpointGitHistory: gitHistory } : {}),
          },
          "Worker could not integrate the saved checkpoint; inspect worker availability or merge conflicts and retry the same request.",
          { assertCurrent: input.assertCurrent },
        );
        result = params.workspaceTransfer.takeUpload(
          params.environmentId,
          NODE_WORKSPACE_EMPTY_MANIFEST_REF,
        );
        const metadata = result.current.entries.find((entry) => entry.path === "snapshot.json");
        if (metadata?.type !== "file") {
          throw new Error("Publication integration snapshot is missing.");
        }
        const { snapshot } = await readGitHubRepositoryPublicationMetadata(
          result.stagingRoot,
          `sha256:${metadata.sha256}`,
        );
        input.assertCurrent();
        if (snapshot.baseCommit !== input.targetCommit) {
          throw new Error("Publication integration base changed.");
        }
        const retained = result;
        result = undefined;
        return {
          snapshot,
          snapshotRoot: retained.stagingRoot,
          release: () => removeNodeWorkspaceUpload(retained),
        };
      } finally {
        if (result) {
          await removeNodeWorkspaceUpload(result);
        }
        if (upload) {
          await params.workspaceTransfer.discardUpload(params.environmentId, upload);
        }
        await params.workspaceTransfer.revoke(params.environmentId, download);
      }
    },
  );
}
