import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerTunnelHandle } from "../../gateway/worker-environments/tunnel-contract.js";
import { prepareWorkerTurnMedia } from "../../gateway/worker-environments/worker-turn-media.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import type { FollowupRun } from "./queue.js";

const { loadScopedCatalog } = vi.hoisted(() => ({
  loadScopedCatalog: vi.fn<() => Promise<ModelCatalogEntry[]>>(),
}));
vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: loadScopedCatalog,
}));

const vision = ["text", "image"] as const;
const textOnly = ["text"] as const;
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ordinary reply model capability at cloud media admission", () => {
  it.each([
    ["prepared vision", vision, "primary", true, false, false],
    ["thinking off", vision, "primary", true, true, false],
    ["prepared text-only", textOnly, "primary", false, false, false],
    ["text-only fallback", vision, "fallback", false, false, false],
    ["vision fallback", textOnly, "fallback", true, false, false],
    ["reasoning-only metadata", undefined, "primary", true, false, false],
    ["missing metadata with thinking off", undefined, "missing", true, true, false],
    ["configured text-only overrides vision", vision, "primary", false, false, true],
  ] as const)(
    "%s preserves selected input through real worker media admission",
    async (_name, input, selected, expected, thinkOff, configured) => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reply-vision-")));
      roots.push(root);
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { workspace: root } } },
        models: configured
          ? {
              providers: {
                acme: {
                  baseUrl: "https://provider.invalid/v1",
                  api: "openai-responses",
                  models: [
                    {
                      id: "primary",
                      name: "Primary",
                      input: ["text"],
                      reasoning: false,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      maxTokens: 1024,
                    },
                  ],
                },
              },
            }
          : undefined,
      };
      const run: FollowupRun["run"] = {
        agentId: "main",
        agentDir: root,
        sessionId: "vision-session",
        sessionFile: "vision-session",
        workspaceDir: root,
        config: cfg,
        provider: "acme",
        model: "primary",
        thinkLevel: thinkOff ? "off" : "medium",
        timeoutMs: 5_000,
        blockReplyBreak: "text_end",
        thinkingCatalog: [
          { provider: "acme", id: "primary", reasoning: true, input },
          { provider: "acme", id: "fallback", input: input === vision ? textOnly : vision },
        ],
      };
      loadScopedCatalog.mockResolvedValue([
        { provider: "acme", id: selected, name: "Selected", input: [...vision] },
      ]);
      const produced = await buildEmbeddedRunExecutionParams({
        run,
        provider: "acme",
        model: selected,
        runId: "vision-run",
        sessionCtx: {},
        hasRepliedRef: undefined,
      });
      const images = [
        createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }),
        createSolidPngBuffer(2, 2, { r: 0, g: 0, b: 255 }),
      ].map((data) => ({
        type: "image" as const,
        data: data.toString("base64"),
        mimeType: "image/png",
      }));
      const staged: Buffer[] = [];
      const unexpected = async (): Promise<never> => {
        throw new Error("unexpected workspace operation");
      };
      const tunnel: WorkerTunnelHandle = {
        environmentId: "vision-worker",
        ownerEpoch: 1,
        runWorkspaceCommand: unexpected,
        syncWorkspace: unexpected,
        quiesceWorkspace: unexpected,
        reconcileWorkspace: unexpected,
        stop: unexpected,
        stageAttachments: async ({ localPath }) => {
          for (const { dirent: entry } of await listDirectoryTreeStrict(localPath)) {
            if (entry.isFile()) {
              staged.push(await fs.readFile(path.join(entry.parentPath, entry.name)));
            }
          }
        },
      };
      const prepared = await prepareWorkerTurnMedia({
        turn: {
          ...produced,
          sessionId: run.sessionId,
          prompt: "Read the codes in order without tools.",
          images,
        },
        history: [],
        workspace: { kind: "local", path: root },
        remoteWorkspaceDir: "/worker",
        tunnel,
        isAuthorized: () => true,
        signal: new AbortController().signal,
      });
      const expectedImages = expected ? images : [];
      expect(prepared.images).toEqual(expectedImages);
      const content =
        typeof prepared.prompt === "string"
          ? [{ type: "text" as const, text: prepared.prompt }]
          : prepared.prompt;
      expect(content.filter((part) => part.type === "image")).toEqual(expectedImages);
      for (const image of expectedImages) {
        expect(staged).toContainEqual(Buffer.from(image.data, "base64"));
      }
    },
  );
});
