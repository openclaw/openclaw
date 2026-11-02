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

const imageDirs = useAutoCleanupTempDirTracker(afterEach);
it.each([
  ["generate", true],
  ["generate", false],
  ["edit", true],
  ["edit", false],
] as const)("publishes %s output only while active (cancel=%s)", async (action, cancel) => {
  const scope = new AsyncWorkScope();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=",
    "base64",
  );
  const root = imageDirs.make("image-interrupt-");
  const input = path.join(root, "input.png");
  const output = path.join(root, "output.png");
  await fs.writeFile(input, png);
  await fs.writeFile(output, "original output");
  mocks.generateImage.mockImplementationOnce(async () => {
    if (cancel) {
      scope.beginClose(new Error("interrupted"));
    }
    return {
      provider: "openai",
      model: "gpt-image-1.5",
      attempts: [],
      images: [{ buffer: png, mimeType: "image/png", fileName: "image.png" }],
    };
  });
  await scope.track(() =>
    runCapability(
      "image",
      action,
      "--prompt",
      "portrait",
      "--model",
      "openai/gpt-image-1.5",
      ...(action === "edit" ? ["--file", input] : []),
      "--output",
      output,
      "--json",
    ),
  );
  expect(await fs.readFile(output)).toEqual(cancel ? Buffer.from("original output") : png);
  expect(mocks.generateImage.mock.calls[0]?.[0].signal?.aborted).toBe(cancel);
  expect(mocks.runtime.writeJson).toHaveBeenCalledTimes(cancel ? 0 : 1);
  expect(mocks.runtime.error).not.toHaveBeenCalled();
});
