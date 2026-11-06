import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runCapability } from "./capability-cli.test-harness.js";

const mocks = await vi.hoisted(async () => ({
  runtime: (await import("./test-runtime-mock.js")).createInertRuntime(vi),
  resolveLocalCapabilityAgent: vi.fn(),
  generateImage: vi.fn(),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
vi.mock("./capability-cli/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capability-cli/shared.js")>()),
  resolveLocalCapabilityAgent: mocks.resolveLocalCapabilityAgent,
}));
vi.mock("../image-generation/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../image-generation/runtime.js")>()),
  generateImage: mocks.generateImage,
}));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=",
  "base64",
);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const runImage = (action: string, aspectRatio: string) =>
  runCapability(
    "image",
    action,
    "--prompt",
    "portrait",
    "--model",
    "openai/gpt-image-1.5",
    ...(action === "edit" ? ["--file", "unused.png"] : []),
    "--aspect-ratio",
    aspectRatio,
    "--json",
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveLocalCapabilityAgent.mockResolvedValue({
    cfg: {},
    agentId: "main",
    agentDir: "/tmp/agent",
  });
  mocks.generateImage.mockResolvedValue({
    provider: "openai",
    model: "gpt-image-1.5",
    attempts: [],
    images: [],
    ignoredOverrides: [],
  });
});

it.each([
  ["generate", "16x9"],
  ["generate", "0:5"],
  ["edit", "16/9"],
  ["edit", "-1:1"],
])("rejects malformed image %s --aspect-ratio %s before dispatch", async (action, value) => {
  await expect(runImage(action, value)).rejects.toThrow("exit 1");
  expect(mocks.runtime.error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
    "--aspect-ratio must be a W:H ratio of positive numbers, like 16:9",
  );
  expect(mocks.resolveLocalCapabilityAgent).not.toHaveBeenCalled();
  expect(mocks.generateImage).not.toHaveBeenCalled();
});

it("passes a numeric aspect ratio outside the tool list to the image runtime", async () => {
  await runImage("generate", "7:5");

  expect(mocks.generateImage).toHaveBeenCalledWith(expect.objectContaining({ aspectRatio: "7:5" }));
});

it.each([false, true])("passes image edit options and respects cancellation=%s", async (cancel) => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const scope = new AsyncWorkScope();
  mocks.generateImage.mockImplementationOnce(async () => {
    if (cancel) {
      scope.beginClose(new Error("interrupted"));
    }
    return {
      provider: "openai",
      model: "gpt-image-1.5",
      attempts: [],
      images: [{ buffer: png, mimeType: "image/png", fileName: "transparent-edit.png" }],
    };
  });
  const directory = tempDirs.make("capability-image-edit-");
  const inputPath = path.join(directory, "input.png");
  const referencePath = path.join(directory, "reference.gif");
  const outputPath = path.join(directory, "output.png");
  await fs.writeFile(inputPath, png);
  if (process.platform === "win32") {
    await fs.writeFile(referencePath, gif);
  } else {
    const referenceTarget = path.join(directory, "reference-target.gif");
    await fs.writeFile(referenceTarget, gif);
    await fs.symlink(referenceTarget, referencePath);
  }
  if (cancel) {
    await fs.writeFile(outputPath, gif);
  }

  const options = {
    count: "3",
    size: "2160x3840",
    "aspect-ratio": "9:16",
    resolution: "4K",
    background: "opaque",
    "timeout-ms": "180000",
    prompt: "make background transparent",
    model: "openai/gpt-image-1.5",
    "output-format": "png",
    "openai-background": "transparent",
    "openai-moderation": "auto",
    quality: "high",
    output: outputPath,
  };
  await scope.track(() =>
    runCapability(
      "image",
      "edit",
      ...[path.relative(process.cwd(), inputPath), referencePath, inputPath].flatMap((file) => [
        "--file",
        file,
      ]),
      ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value]),
      "--json",
    ),
  );
  expect(await fs.readFile(outputPath)).toEqual(cancel ? gif : png);
  if (cancel) {
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.generateImage.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    return;
  }

  expect(mocks.generateImage.mock.calls[0]?.[0]).toMatchObject({
    prompt: "make background transparent",
    modelOverride: "openai/gpt-image-1.5",
    outputFormat: "png",
    quality: "high",
    count: 3,
    size: "2160x3840",
    aspectRatio: "9:16",
    resolution: "4K",
    background: "opaque",
    timeoutMs: 180000,
    providerOptions: { openai: { background: "transparent", moderation: "auto" } },
    inputImages: [
      { buffer: png, fileName: "input.png", mimeType: "image/png" },
      { buffer: gif, fileName: "reference.gif", mimeType: "image/gif" },
      { buffer: png, fileName: "input.png", mimeType: "image/png" },
    ],
  });
  expect(mocks.runtime.writeJson.mock.calls[0]?.[0]).toMatchObject({
    outputs: [expect.objectContaining({ path: outputPath, mimeType: "image/png" })],
  });
});

it.skipIf(process.platform === "win32").each([false, true])(
  "rejects FIFO image edits before generation (symlink: %s)",
  async (symlink) => {
    const directory = tempDirs.make("capability-image-fifo-");
    const fifo = path.join(directory, "input.pipe");
    execFileSync("mkfifo", [fifo]);
    const input = symlink ? `${fifo}.link` : fifo;
    if (symlink) {
      await fs.symlink(fifo, input);
    }
    // Release a regressed reader so the assertion fails without stranding the runner.
    const writer = spawn(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'))",
        fifo,
        png.toString("base64"),
      ],
      { stdio: "ignore" },
    );
    const closed = new Promise((resolve) => {
      writer.once("close", resolve);
    });
    try {
      await expect(
        runCapability("image", "edit", "--file", input, "--prompt", "edit", "--json"),
      ).rejects.toThrow("exit 1");
      expect(mocks.runtime.error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        `Cannot read image edit input: ${input}. Use a readable regular file and retry.`,
      );
      expect(mocks.generateImage).not.toHaveBeenCalled();
      expect((await fs.stat(fifo)).isFIFO()).toBe(true);
    } finally {
      writer.kill("SIGKILL");
      await closed;
    }
  },
);
