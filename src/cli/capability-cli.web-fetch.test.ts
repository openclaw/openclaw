import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCap } from "./capability-cli.test-harness.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async (_args: Record<string, unknown>) => ({ content: "page content" })),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeJson: vi.fn(),
  },
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: { writeJson: (value: unknown) => void }, value: unknown) =>
    runtime.writeJson(value),
}));

vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("./command-secret-targets.js", () => ({
  getCapabilityWebFetchCommandSecretTargets: () => ({ targetIds: new Set() }),
}));
vi.mock("./capability-cli/shared.js", () => ({
  resolveLocalCapabilityRuntimeConfig: async () => ({}),
}));
vi.mock("../web-fetch/runtime.js", () => ({
  resolveWebFetchDefinition: () => ({
    provider: { id: "fixture-fetch" },
    definition: { execute: mocks.execute },
  }),
}));

describe("web fetch CLI extraction mode", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { root: "infer", format: "text" },
    { root: "capability", format: "text" },
    { root: "infer", format: "markdown" },
    { root: "infer", format: undefined },
  ])("forwards $root format $format to the provider", async ({ root, format }) => {
    await runCap(
      root,
      "web",
      "fetch",
      "--url",
      "https://example.com",
      ...(format ? ["--format", format] : []),
      "--json",
    );

    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith({
      url: "https://example.com",
      extractMode: format,
    });
  });
});
