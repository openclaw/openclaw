import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForEmbeddedAgentRunEnd } from "../../agents/embedded-agent-runner/runs.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { saveMediaBuffer } from "../../media/store.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  buildPersistedUserTurnMessage,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  attachedEnvironment,
  acknowledgeCompletedWorkerTurn,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  credential,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { applyStagedWorkerWorkspace } from "./workspace-reconcile.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

beforeEach(setupWorkerTurnLauncherTest);
afterEach(cleanupWorkerTurnLauncherTest);

it.each(["worker-turn", "remote-exec"] as const)(
  "keeps later image and PDF originals readable with %s retention",
  async (executionMode) => {
    const physicalRoot = await realpath(root);
    const remote = path.join(physicalRoot, "remote");
    const local = path.join(physicalRoot, "local");
    const remoteHome = path.join(physicalRoot, "remote-home");
    const relative = (file: string) => path.relative(remote, file).split(path.sep).join("/");
    await Promise.all([mkdir(remote), mkdir(local), mkdir(remoteHome)]);
    for (const directory of [remote, local]) {
      await writeFile(path.join(directory, "remote-edits.txt"), "preserve me");
    }
    const base = await captureWorkspaceManifest({ root: local, baseCommit: null });
    await seedActivePlacement(executionMode, remote);
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
      target: { ...sessionTarget, sessionEntry: { sessionId: SESSION_ID, updatedAt: 1 } },
    });
    const input = {
      ...turn(),
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
      for (const entry of await readdir(remote, { recursive: true, withFileTypes: true })) {
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
    const tunnel = createWorkerTurnTunnel({
      runWorkspaceCommand: vi.fn(async (command) => {
        parseNodeWorkerWorkspaceExecInput(
          JSON.stringify({
            gatewayNamespace: "attachments",
            environmentId: ENVIRONMENT_ID,
            sessionId: SESSION_ID,
            generation: OWNER_EPOCH,
            argv: command.argv,
            input: command.input,
          }),
        );
        return await runCommandWithTimeout([...command.argv], {
          cwd: remote,
          input: command.input,
          timeoutMs: 10_000,
          signal: command.signal,
        });
      }),
      stageAttachments: async (request) => {
        const service = createNodeWorkspaceTransferService({
          getOwner: () => ({ credential: credential(), environment: attachedEnvironment() }),
          temporaryRoot: path.join(remoteHome, "transfers"),
        });
        const server = await startNodeWorkspaceTransferTestServer(service);
        try {
          await service.prepareSync({
            environmentId: ENVIRONMENT_ID,
            ownerEpoch: OWNER_EPOCH,
            sessionId: SESSION_ID,
            localPath: local,
            isAuthorized: request.isAuthorized,
          });
          const prepared = await service.prepareAttachments({
            ...request,
            environmentId: ENVIRONMENT_ID,
          });
          await runNodeWorkerWorkspaceTransfer({
            gatewayUrl: server.gatewayUrl,
            environmentId: ENVIRONMENT_ID,
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
        const session = await openSessionManager();
        const transcriptLeafId = await session.appendMessageAsync(
          makeAgentAssistantMessage({ content: [{ type: "text", text: "Read both" }] }),
        );
        return await acknowledgeCompletedWorkerTurn(request.turnClaim, transcriptLeafId);
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
          baseManifestRef: MANIFEST_REF,
          currentManifestRef: manifestRef,
          base: base.manifest,
          current: parseWorkerWorkspaceManifest(raw, manifestRef),
          acceptance: { kind: "reconcile" },
          journal: request.source.journal,
        });
        workerManifestPaths = JSON.parse(raw).entries.map((entry: { path: string }) => entry.path);
        acceptedManifestPaths = result.manifest.entries.map((entry) => entry.path);
        return {
          ...result,
          changed: true,
          verifyStable: async () => {},
          publishStagedResult: async () => {},
          discardPreparedStagedResult: async () => {},
        };
      }),
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      placements,
      resolveWorkspace: async () => ({ kind: "local", path: local }),
      environments: {
        ...unusedEnvironments(),
        get: attachedEnvironment,
        acquireTurnCredential: async () => credential(),
        acknowledgeCredentialDelivery: async () => true,
        startTunnel: async () => tunnel,
      },
    });
    await provider.executeTurn({ ...sessionTarget, runId: input.runId }, input, async () => {
      await verifyFiles(input.prompt);
      return { meta: { durationMs: 1 } };
    });
    await waitForEmbeddedAgentRunEnd(SESSION_ID, null);
    if (executionMode === "remote-exec") {
      const commands = vi.mocked(tunnel.runWorkspaceCommand).mock.calls;
      expect(commands.at(-1)?.[0].input).toBe(JSON.stringify({ op: "discover" }));
      // At most one setup, three PDF chunks, and one image chunk.
      expect(commands.length - 1).toBeLessThanOrEqual(5);
    }
    expect(tunnel.syncWorkspace).not.toHaveBeenCalled();
    expect(tunnel.reconcileWorkspace).toHaveBeenCalledOnce();
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
      (await readdir(local, { recursive: true }))
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
