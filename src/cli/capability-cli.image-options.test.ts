import { beforeEach, expect, it, vi } from "vitest";
import { runCapability } from "./capability-cli.test-harness.js";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
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
