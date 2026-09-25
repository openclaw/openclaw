import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../../cli/failure-output.js";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), getConfig: vi.fn(() => ({})) }));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: mocks.getConfig }));
vi.mock("../../model-catalog/remote-refresh.js", () => ({
  refreshRemoteModelCatalog: mocks.refresh,
}));

import { modelsRefreshCommand } from "./refresh.js";

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

beforeEach(() => mocks.refresh.mockReset());

describe("models refresh", () => {
  it("emits one JSON document without mixing in the human activation notice", async () => {
    const commandRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce({
      status: "updated",
      providers: 2,
      models: 3,
      generatedAt: 1_753_500_000_000,
    });
    await modelsRefreshCommand({ json: true }, commandRuntime);
    const output = commandRuntime.log.mock.calls.flat().join("\n");
    expect(JSON.parse(output)).toEqual({
      status: "updated",
      providers: 2,
      models: 3,
      generatedAt: 1_753_500_000_000,
    });
    expect(commandRuntime.error).not.toHaveBeenCalled();
  });

  it("leaves JSON failure output to the canonical CLI error owner", async () => {
    const commandRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce({
      status: "error",
      providers: 0,
      models: 0,
      error: "boom",
    });

    const execution = modelsRefreshCommand({ json: true }, commandRuntime);

    await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
    expect(commandRuntime.log).not.toHaveBeenCalled();
    expect(commandRuntime.error).not.toHaveBeenCalled();
    expect(commandRuntime.exit).not.toHaveBeenCalled();
  });
});
