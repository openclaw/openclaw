import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as imageRuntime from "../../image-generation/runtime.js";
import * as mediaStore from "../../media/store.js";
import { expectDefined } from "../../plugin-sdk/expect-runtime.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { createImageGenerateTool } from "./image-generate-tool.js";
import * as mediaProviders from "./media-generation-tool-providers.js";
import * as pdfNativeProviders from "./pdf-native-providers.js";
import {
  createPdfToolInfraStub,
  FAKE_PDF_MEDIA,
  resetPdfToolAuthEnv,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

// mock-isolation: file URL tests must not register live provider streams.
vi.mock("../provider-stream.js", () => ({ registerProviderStreamForModel: vi.fn() }));

// mock-isolation: this fixture discovers only the built-in media tools, not installed plugins.
vi.mock("../openclaw-plugin-tools.js", () => ({ resolveOpenClawPluginToolsForOptions: () => [] }));

const { stubPdfToolInfra } = createPdfToolInfraStub(completeMock);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
  "base64",
);

function requireTool(tools: ReturnType<typeof createOpenClawTools>, name: "view_image" | "pdf") {
  return expectDefined(
    tools.find((tool) => tool.name === name),
    `registered ${name} tool`,
  );
}

describe.runIf(process.platform === "win32")("host-local media tool file URLs", () => {
  beforeEach(() => {
    resetPdfToolAuthEnv();
    completeMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("loads Unicode and space file URLs through registered image and PDF tools", async () => {
    await withTempPdfAgentDir((agentDir) =>
      withTempDir("openclaw-media-file-url-Å ", async (workspaceDir) => {
        const imagePath = path.join(workspaceDir, "café image.png");
        const pdfPath = path.join(workspaceDir, "résumé document.pdf");
        await fs.writeFile(imagePath, ONE_PIXEL_PNG);
        await fs.writeFile(pdfPath, FAKE_PDF_MEDIA.buffer);
        await stubPdfToolInfra(agentDir, { mockLoad: false });
        vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");

        const config: OpenClawConfig = {
          agents: {
            entries: { main: {} },
            defaults: { pdfModel: { primary: "anthropic/claude-opus-4-6" } },
          },
        } as OpenClawConfig;
        const tools = createOpenClawTools({
          agentDir,
          workspaceDir,
          config,
          modelHasVision: true,
          disableMessageTool: true,
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
        });

        const imageUrl = pathToFileURL(imagePath).href;
        const imageResult = await requireTool(tools, "view_image").execute("image-call", {
          path: imageUrl,
        });
        expect(imageResult.content).toEqual([
          {
            type: "text",
            text: "Loaded 1 image into private model context for inspection; not displayed, attached, or sent to the user.",
          },
          expect.objectContaining({ type: "image" }),
        ]);

        const pdfResult = await requireTool(tools, "pdf").execute("pdf-call", {
          pdf: pathToFileURL(pdfPath).href,
          prompt: "summarize",
        });
        expect(pdfResult.content).toEqual([{ type: "text", text: "native summary" }]);
        expect(pdfResult.details).toMatchObject({ pdf: pdfPath, native: true });

        vi.spyOn(mediaProviders, "acquireMediaGenerationToolProviders").mockResolvedValue({
          providers: [
            {
              id: "fixture",
              capabilities: {
                generate: {},
                edit: { enabled: true, maxInputImages: 1 },
              },
              generateImage: async () => {
                throw new Error("runtime generateImage spy should own the call");
              },
            },
          ],
          assertOpen() {},
          run: async (run) => await run(),
          release: async () => {},
        });
        const generateImage = vi.spyOn(imageRuntime, "generateImage").mockResolvedValue({
          provider: "fixture",
          model: "edit",
          attempts: [],
          ignoredOverrides: [],
          images: [{ buffer: ONE_PIXEL_PNG, mimeType: "image/png", fileName: "edited.png" }],
        });
        vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
          path: path.join(workspaceDir, "edited.png"),
          id: "edited.png",
          size: ONE_PIXEL_PNG.length,
          contentType: "image/png",
        });
        const generationTool = expectDefined(
          createImageGenerateTool({
            agentDir,
            workspaceDir,
            config: {
              agents: { defaults: { mediaModels: { image: { primary: "fixture/edit" } } } },
            },
          }),
          "image_generate tool",
        );
        expect(generationTool.name).toBe("image_generate");
        await generationTool.execute("generation-call", {
          prompt: "edit the reference",
          image: imageUrl,
        });
        expect(generateImage.mock.calls[0]?.[0]).toMatchObject({
          inputImages: [{ buffer: ONE_PIXEL_PNG }],
        });
      }),
    );
  });
});
