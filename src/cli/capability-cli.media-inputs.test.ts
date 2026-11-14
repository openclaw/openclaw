import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCap } from "./capability-cli.test-harness.js";

const mocks = await vi.hoisted(async () => ({
  runtime: (await import("./test-runtime-mock.js")).createInertRuntime(vi),
  resolveLocalCapabilityAgent: vi.fn(async () => ({
    cfg: {},
    agentId: "main",
    agentDir: "/tmp/agent",
  })),
  transcribeAudioFile:
    vi.fn<typeof import("../media-understanding/runtime.js").transcribeAudioFile>(),
  describeVideoFile: vi.fn<typeof import("../media-understanding/runtime.js").describeVideoFile>(),
  describeImageFile: vi.fn<typeof import("../media-understanding/runtime.js").describeImageFile>(),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
vi.mock("./capability-cli/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capability-cli/shared.js")>()),
  resolveLocalCapabilityAgent: mocks.resolveLocalCapabilityAgent,
}));
vi.mock("../media-understanding/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media-understanding/runtime.js")>()),
  transcribeAudioFile: mocks.transcribeAudioFile,
  describeVideoFile: mocks.describeVideoFile,
  describeImageFile: mocks.describeImageFile,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const firstJsonOutput = () => mocks.runtime.writeJson.mock.calls[0]?.[0];

beforeEach(() => {
  vi.clearAllMocks();
});

it.skipIf(process.platform === "win32").each([
  ["audio", "transcribe", "memo.wav"],
  ["video", "describe", "clip.mp4"],
  ["image", "describe", "image.png"],
  ["image", "describe-many", "image.png"],
] as const)("reads the selected %s through a symlink parent", async (kind, action, name) => {
  const root = await fs.realpath(tempDirs.make("infer-media-parent-"));
  const physical = path.join(root, "physical");
  const selected = path.join(physical, name);
  await fs.mkdir(path.join(physical, "nested"), { recursive: true });
  await fs.symlink(path.join(physical, "nested"), path.join(root, "link"), "dir");
  await fs.writeFile(path.join(physical, "payload.bin"), "selected input bytes");
  await fs.symlink("payload.bin", selected);
  await fs.writeFile(path.join(root, name), "lexical decoy bytes");
  const runtime =
    kind === "audio"
      ? mocks.transcribeAudioFile
      : kind === "video"
        ? mocks.describeVideoFile
        : mocks.describeImageFile;
  runtime.mockImplementationOnce(async ({ filePath }) => ({
    text: await fs.readFile(filePath, "utf8"),
  }));
  await runCap("infer", kind, action, "--file", `${root}/link/../${name}`, "--json");
  expect(firstJsonOutput()).toMatchObject({
    outputs: [{ path: selected, text: "selected input bytes" }],
  });
});
