import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../../cli/expected-cli-error.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), getConfig: vi.fn(() => ({})) }));
// mock-isolation: Output tests exercise an offline refresh; admission has separate boundary coverage.
vi.mock("../../cli/local-state-owner.js", () => ({
  runWithLocalStateOwner: async ({
    runLocal,
  }: Parameters<typeof import("../../cli/local-state-owner.js").runWithLocalStateOwner>[0]) =>
    runLocal({
      env: process.env,
      config: mocks.getConfig(),
      signal: new AbortController().signal,
      assertCurrent() {},
    }),
}));
vi.mock("../../model-catalog/remote-refresh.js", () => ({
  refreshRemoteModelCatalog: mocks.refresh,
}));

import { modelsRefreshCommand } from "./refresh.js";

const commandRuntime = { ...createTestRuntime(), writeStdout: vi.fn(), writeJson: vi.fn() };
const catalog = { providers: 2, models: 3, generatedAt: 1_753_500_000_000 };

function expectNoFailureOutput() {
  expect(commandRuntime.log).not.toHaveBeenCalled();
  expect(commandRuntime.error).not.toHaveBeenCalled();
  expect(commandRuntime.exit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockReset();
});

describe("models refresh", () => {
  it.each(["updated", "fresh", "disabled"] as const)("prints %s human results", async (status) => {
    mocks.refresh.mockResolvedValueOnce(
      status === "disabled" ? { status, providers: 0, models: 0 } : { status, ...catalog },
    );
    await modelsRefreshCommand({}, commandRuntime);
    expect(commandRuntime.log).toHaveBeenLastCalledWith(
      status === "disabled"
        ? "Remote catalog refresh is disabled (models.catalogRefresh.enabled=false)"
        : expect.stringContaining(`Remote catalog refresh: ${status}`),
    );
  });

  it("delegates refresh failures to the canonical CLI error owner", async () => {
    mocks.refresh.mockResolvedValueOnce({
      status: "error",
      providers: 0,
      models: 0,
      error: "boom",
    });

    const execution = modelsRefreshCommand({ json: true }, commandRuntime);

    await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(execution).rejects.toMatchObject({
      message: "Remote catalog refresh failed: boom",
      humanOutput: "Remote catalog refresh failed: boom",
      machineOutput: "Remote catalog refresh failed: boom",
    });
    expect(commandRuntime.writeJson).not.toHaveBeenCalled();
    expectNoFailureOutput();
  });

  it("preserves the JSON domain payload", async () => {
    const result = { status: "fresh", ...catalog, nextCheckInMs: 1_000 };
    mocks.refresh.mockResolvedValueOnce(result);

    await modelsRefreshCommand({ json: true }, commandRuntime);

    expect(commandRuntime.writeJson).toHaveBeenCalledWith(result, 0);
    expectNoFailureOutput();
  });
});
