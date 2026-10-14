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
  resolveCommandConfigWithSecrets: vi.fn(),
  generateImage: vi.fn(),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
vi.mock("./command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));
vi.mock("../image-generation/runtime.js", () => ({ generateImage: mocks.generateImage }));

beforeEach(() => {
  vi.clearAllMocks();
});

it.each([
  ["generate", "--resolution", "1080p", "resolution must be one of 1K, 2K, or 4K"],
  ["edit", "--resolution", "1080p", "resolution must be one of 1K, 2K, or 4K"],
  ["generate", "--aspect-ratio", "16x9", "--aspect-ratio must be one of 1:1, 2:1,"],
  ["edit", "--aspect-ratio", "16x9", "--aspect-ratio must be one of 1:1, 2:1,"],
])("rejects invalid image %s %s before dispatch", async (action, option, value, message) => {
  await expect(
    runCapability(
      "image",
      action,
      "--prompt",
      "portrait",
      ...(action === "edit" ? ["--file", "unused.png"] : []),
      option,
      value,
      "--json",
    ),
  ).rejects.toThrow("exit 1");
  expect(mocks.runtime.error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
    message,
  );
  expect(mocks.resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
  expect(mocks.generateImage).not.toHaveBeenCalled();
});
