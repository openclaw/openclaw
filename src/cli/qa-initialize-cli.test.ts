import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerQaInitializeCli } from "./qa-initialize-cli.js";

const runtime = vi.hoisted(() => ({
  initializeQaRuntimeState: vi.fn<() => Promise<void>>(),
  closeQaRuntimeStores: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../dist/plugin-sdk/qa-runtime.js", () => runtime);
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])("drains the fixture stores when initialization fails: %s", async (fails) => {
  vi.stubEnv("OPENCLAW_QA_TEMP_ROOT", "/isolated/qa");
  const failure = new Error("initializer failed");
  if (fails) {
    runtime.initializeQaRuntimeState.mockRejectedValue(failure);
  }
  const program = new Command();
  registerQaInitializeCli(program);
  const result = program.parseAsync(["node", "openclaw", "qa", "initialize"]);
  if (fails) {
    await expect(result).rejects.toThrow("QA initialization failed: initializer failed");
  } else {
    await result;
  }
  expect(runtime.initializeQaRuntimeState).toHaveBeenCalledOnce();
  expect(runtime.closeQaRuntimeStores).toHaveBeenCalledExactlyOnceWith("/isolated/qa");
});
