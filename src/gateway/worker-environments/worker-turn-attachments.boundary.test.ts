import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import { saveMediaBuffer } from "../../media/store.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import {
  buildPersistedUserTurnMessage,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import * as worker from "./worker-turn-launcher.test-support.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { applyStagedWorkerWorkspace } from "./workspace-reconcile.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

beforeEach(worker.setupWorkerTurnLauncherTest);
afterEach(async () => {
  await worker.cleanupWorkerTurnLauncherTest();
  vi.unstubAllEnvs();
});

it.each(["worker-turn", "remote-exec"] as const)(
  "keeps later image and PDF originals readable with %s retention",
  async (executionMode) => {
    const physicalRoot = await realpath(worker.root);
    const remote = path.join(physicalRoot, "remote");
    const local = path.join(physicalRoot, "local");
    const remoteHome = path.join(physicalRoot, "remote-home");
    const bin = path.join(physicalRoot, "bin");
    const relative = (file: string) => path.relative(remote, file).split(path.sep).join("/");
    await Promise.all([mkdir(remote), mkdir(local), mkdir(remoteHome), mkdir(bin)]);
    await writeFile(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    for (const directory of [remote, local]) {
      await writeFile(path.join(directory, "remote-edits.txt"), "preserve me");
    }
    let base = await captureWorkspaceManifest({ root: local, baseCommit: null });
    await worker.seedActivePlacement(executionMode, remote, base.manifestRef);
    // These arrive after placement: the initial workspace snapshot cannot include them.
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(220_000, 65)]);
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
      "base64",
    );
    const media = await Promise.all([
      saveMediaBuffer(pdf, "application/pdf", "inbound", pdf.length, "report.pdf"),
      saveMediaBuffer(image, "image/png", "inbound", image.length, "photo.png"),
    ]);
    const recorder = createUserTurnTranscriptRecorder({
      message: buildPersistedUserTurnMessage({ text: "Read both attachments", media }),
      target: {
        ...worker.sessionTarget,
        sessionEntry: { sessionId: worker.SESSION_ID, updatedAt: 1 },
      },
    });
    const input = {
      ...worker.turn(),
      workspaceDir: local,
      prompt: "Read both attachments",
      media: [media[0]!],
      userTurnTranscriptRecorder: recorder,
    };
    const originalFiles = new Map<string, Buffer>();
    const outputFiles = {
      "remote-edits.txt": "worker edit",
      "report.txt": "Read both attachments",
      "openclaw-inbound-project/report.txt": "user project output",
      "openclaw-inbound-12345678-1234-4234-8234-123456789ab-/report.txt": "user project output",
    };
    let workerManifestPaths: string[] = [];
    let acceptedManifestPaths: string[] = [];
    const verifyFiles = async (prompt: string) => {
      const files: Buffer[] = [];
      for (const entry of (await listDirectoryTreeStrict(remote)).map(
        (walkEntry) => walkEntry.dirent,
      )) {
        if (!entry.isFile() || entry.name === "remote-edits.txt") {
          continue;
        }
        const file = path.join(entry.parentPath, entry.name);
        const bytes = await readFile(file);
        originalFiles.set(file, bytes);
        if (entry.name === ".gitignore") {
          continue;
        }
        files.push(bytes);
        expect(prompt).toContain(relative(path.dirname(file)));
      }
      expect(files).toHaveLength(2);
      expect(files).toEqual(expect.arrayContaining([pdf, image]));
      expect(await readFile(path.join(remote, "remote-edits.txt"), "utf8")).toBe("preserve me");
      for (const [file, content] of Object.entries(outputFiles)) {
        await mkdir(path.dirname(path.join(remote, file)), { recursive: true });
        await writeFile(path.join(remote, file), content);
      }
    };
    const tunnel = worker.createWorkerTurnTunnel({
      runWorkspaceCommand: vi.fn(async (command) => {
        return await runCommandWithTimeout([...command.argv], {
          cwd: remote,
          input: command.input,
          timeoutMs: 10_000,
          signal: command.signal,
        });
      }),
      stageAttachments: async (request) => {
        const service = createNodeWorkspaceTransferService({
          getOwner: () => ({
            credential: worker.credential(),
            environment: worker.attachedEnvironment(),
          }),
          temporaryRoot: path.join(remoteHome, "transfers"),
        });
        const server = await startNodeWorkspaceTransferTestServer(service);
        try {
          await service.prepareSync({
            environmentId: worker.ENVIRONMENT_ID,
            ownerEpoch: worker.OWNER_EPOCH,
            sessionId: worker.SESSION_ID,
            localPath: local,
            isAuthorized: request.isAuthorized,
          });
          const prepared = await service.prepareAttachments({
            ...request,
            environmentId: worker.ENVIRONMENT_ID,
          });
          await runNodeWorkerWorkspaceTransfer({
            gatewayUrl: server.gatewayUrl,
            environmentId: worker.ENVIRONMENT_ID,
            workspaceDir: remote,
            manifestHome: remoteHome,
            transfer: {
              direction: "download",
              token: prepared.token,
              manifestRef: prepared.snapshot.manifestRef,
              attachments: true,
            },
            signal: request.signal,
          });
        } finally {
          await service.closeAll();
          await server.close();
        }
      },
      launchTurn: vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
        const prompt = request.plan.assignment.prompt;
        await verifyFiles(
          typeof prompt === "string"
            ? prompt
            : prompt.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        );
        request.onDispatchReady?.();
        const session = await worker.openSessionManager();
        const transcriptLeafId = await session.appendMessageAsync(
          makeAgentAssistantMessage({ content: [{ type: "text", text: "Read both" }] }),
        );
        return await worker.acknowledgeCompletedWorkerTurn(request.turnClaim, transcriptLeafId);
      }),
      reconcileWorkspace: vi.fn(async (request) => {
        if (request.source.kind !== "local") {
          throw new Error("expected a local workspace source");
        }
        const capture = await runCommandWithTimeout(
          [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, remote],
          { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: remoteHome } },
        );
        expect(capture.code, capture.stderr).toBe(0);
        const manifestRef = capture.stdout.trim();
        const raw = await readFile(
          path.join(remoteHome, ".openclaw-worker", "manifests", `${manifestRef.slice(7)}.json`),
          "utf8",
        );
        const result = await applyStagedWorkerWorkspace({
          root: local,
          stagingRoot: remote,
          baseManifestRef: request.baseManifestRef,
          currentManifestRef: manifestRef,
          base: base.manifest,
          current: parseWorkerWorkspaceManifest(raw, manifestRef),
          acceptance: { kind: "reconcile" },
          journal: request.source.journal,
        });
        workerManifestPaths = JSON.parse(raw).entries.map((entry: { path: string }) => entry.path);
        acceptedManifestPaths = result.manifest.entries.map((entry) => entry.path);
        base = result;
        return {
          ...result,
          changed: true,
          verifyStable: async () => {},
          publishStagedResult: async () => {},
          discardPreparedStagedResult: async () => {},
        };
      }),
    });
    const provider = worker.createWorkerSessionTurnPlacementProvider({
      placements: worker.placements,
      resolveWorkspace: async () => ({ kind: "local", path: local }),
      environments: worker.workerTurnEnvironments(tunnel, {
        acknowledgeCredentialDelivery: async () => true,
      }),
    });
    await provider.executeTurn({ ...worker.sessionTarget, runId: input.runId }, input, async () => {
      await verifyFiles(input.prompt);
      return { meta: { durationMs: 1 } };
    });
    await waitForSessionRunEnd(worker.SESSION_ID, null);
    if (executionMode === "remote-exec") {
      const commands = vi.mocked(tunnel.runWorkspaceCommand).mock.calls;
      expect(commands.at(-1)?.[0].input).toBe(JSON.stringify({ op: "discover" }));
      // At most one setup, three PDF chunks, and one image chunk.
      expect(commands.length - 1).toBeLessThanOrEqual(5);
    }
    expect(tunnel.syncWorkspace).not.toHaveBeenCalled();
    // Refresh inputs before execution, then settle the completed turn's workspace.
    expect(tunnel.reconcileWorkspace).toHaveBeenCalledTimes(2);
    const retainedFiles =
      executionMode === "worker-turn" ? [...originalFiles.keys()].map(relative) : [];
    const expectedFiles = [...Object.keys(outputFiles), ...retainedFiles].toSorted();
    const ancestors = (file: string) => {
      const segments = file.split("/");
      return segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
    };
    const expectedPaths = [...new Set(expectedFiles.flatMap(ancestors))].toSorted();
    expect(workerManifestPaths).toEqual(expectedPaths);
    expect(acceptedManifestPaths).toEqual(expectedFiles);
    expect(
      (await listDirectoryTreeStrict(local))
        .map((walkEntry) => walkEntry.relativePath)
        .map((entry) => entry.split(path.sep).join("/"))
        .toSorted(),
    ).toEqual(expectedPaths);
    for (const [file, content] of Object.entries(outputFiles)) {
      expect(await readFile(path.join(local, file), "utf8")).toBe(content);
    }
    for (const [file, bytes] of originalFiles) {
      expect(await readFile(file)).toEqual(bytes);
      if (executionMode === "worker-turn") {
        expect(await readFile(path.join(local, path.relative(remote, file)))).toEqual(bytes);
      }
    }
    expect(input.prompt).toBe("Read both attachments");
  },
);
