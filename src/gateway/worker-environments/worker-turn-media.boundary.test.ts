import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import type { MediaFact } from "../../media/media-facts.js";
import { saveMediaBuffer } from "../../media/store.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  cleanupWorkerTurnLauncherTest,
  root,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";
import { prepareWorkerTurnMedia } from "./worker-turn-media.js";

beforeEach(setupWorkerTurnLauncherTest);
afterEach(cleanupWorkerTurnLauncherTest);

function mediaFixture(
  workspace: WorkerSessionWorkspace,
  remoteWorkspaceDir: string,
  config?: Parameters<typeof prepareWorkerTurnMedia>[0]["turn"]["config"],
) {
  const staged: Buffer[] = [];
  const stageAttachments = vi.fn<NonNullable<WorkerTunnelHandle["stageAttachments"]>>(
    async (request) => {
      expect(request.isAuthorized()).toBe(true);
      for (const name of (await listDirectoryTreeStrict(request.localPath)).map(
        (walkEntry) => walkEntry.relativePath,
      )) {
        const source = path.join(request.localPath, name);
        if (path.basename(name) !== ".gitignore" && (await fs.stat(source)).isFile()) {
          staged.push(await fs.readFile(source));
        }
      }
    },
  );
  const input = turn("media-policy");
  const prepare = (media: MediaFact[], history: AgentMessage[] = []) =>
    prepareWorkerTurnMedia({
      turn: {
        ...input,
        media,
        config: config ?? input.config,
      },
      workspace,
      remoteWorkspaceDir,
      history,
      tunnel: {
        environmentId: "media-policy-environment",
        ownerEpoch: 1,
        stageAttachments,
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        quiesceWorkspace: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        stop: vi.fn(),
      },
      signal: new AbortController().signal,
      isAuthorized: () => true,
    });
  return { stageAttachments, staged, prepare };
}

describe.each(["local", "repository"] as const)("%s workspace media policy", (kind) => {
  async function fixture(workspaceOnly: boolean) {
    const gatewayWorkspace = path.join(root, "gateway-agent-workspace");
    const localWorkspace = path.join(root, "session-workspace");
    await Promise.all([fs.mkdir(gatewayWorkspace), fs.mkdir(localWorkspace)]);
    const workspace: WorkerSessionWorkspace =
      kind === "local"
        ? { kind, path: localWorkspace }
        : {
            kind,
            repository: await getSessionRepositoryWorkspaceStore().create({
              agentId: sessionTarget.agentId,
              sessionKey: sessionTarget.sessionKey,
              url: "https://github.com/example/repository.git",
              assertCurrent: () => {},
            }),
          };
    // Matching remote cwd metadata must not grant access to the Gateway directory.
    return {
      gatewayWorkspace,
      localWorkspace,
      ...mediaFixture(workspace, gatewayWorkspace, {
        tools: { fs: { workspaceOnly } },
        agents: { defaults: { workspace: gatewayWorkspace } },
      }),
    };
  }

  it.each([
    { workspaceOnly: true, contentType: "image/png", name: "image.png" },
    { workspaceOnly: true, contentType: "text/plain", name: "document.txt" },
    { workspaceOnly: false, contentType: "image/png", name: "image.png" },
    { workspaceOnly: false, contentType: "text/plain", name: "document.txt" },
  ])(
    "applies workspaceOnly=$workspaceOnly to Gateway $contentType sources",
    async ({ workspaceOnly, contentType, name }) => {
      const f = await fixture(workspaceOnly);
      const data =
        contentType === "image/png"
          ? createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 })
          : Buffer.from("Gateway agent file outside this session workspace");
      const source = path.join(f.gatewayWorkspace, name);
      await fs.writeFile(source, data);
      const preparation = f.prepare([{ path: source, contentType }]);
      if (workspaceOnly) {
        await expect(preparation).rejects.toThrow(
          contentType === "image/png" ? "could not load 1 image" : "not under an allowed directory",
        );
        expect(f.stageAttachments).not.toHaveBeenCalled();
      } else {
        await preparation;
        expect(f.staged).toEqual([data]);
      }
    },
  );

  it("keeps managed originals readable under workspace-only policy", async () => {
    const f = await fixture(true);
    const image = createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 });
    const document = Buffer.from("Managed incoming document");
    const savedImage = await saveMediaBuffer(image, "image/png", "inbound");
    const savedDocument = await saveMediaBuffer(document, "text/plain", "inbound");
    const media: MediaFact[] = [
      { url: `media://inbound/${savedImage.id}`, contentType: "image/png" },
      { path: savedDocument.path, contentType: "text/plain" },
    ];
    const expected = [image, document];
    if (kind === "local") {
      const local = Buffer.from("Owned local session file");
      const source = path.join(f.localWorkspace, "owned.txt");
      await fs.writeFile(source, local);
      media.push({ path: source, contentType: "text/plain" });
      expected.push(local);
    }
    const prepared = await f.prepare(media);
    expect(prepared.images).toHaveLength(1);
    expect(f.stageAttachments).toHaveBeenCalledOnce();
    expect(f.staged).toHaveLength(expected.length);
    expect(f.staged).toEqual(expect.arrayContaining(expected));
  });
});

it("refuses device-folder attachments and does not restage a refused one from history", async () => {
  const saved = await saveMediaBuffer(Buffer.from("Refused note"), "text/plain", "inbound");
  const fact: MediaFact = { path: saved.path, contentType: "text/plain" };
  const { prepare, stageAttachments } = mediaFixture(
    { kind: "device-folder", deviceId: "device-1", path: "/srv/project" },
    "/srv/project",
  );
  await expect(prepare([fact])).rejects.toThrow("Attachments are not supported");
  const refused = {
    role: "user",
    content: [{ type: "text", text: "Read the note" }],
    timestamp: 1,
    __openclaw: { media: [fact] },
  } as AgentMessage;
  await expect(prepare([], [refused])).resolves.toBeDefined();
  expect(stageAttachments).not.toHaveBeenCalled();
});
