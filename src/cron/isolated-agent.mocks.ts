import { vi } from "vitest";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";

const {
  resolveFastModeStateMock,
  resolveNestedAgentLaneMock,
  resolveThinkingDefaultMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} = vi.hoisted(() => ({
  resolveFastModeStateMock: vi.fn(() => ({ enabled: false, source: "default" })),
  resolveNestedAgentLaneMock: vi.fn((lane?: string) => {
    const trimmed = lane?.trim();
    return !trimmed || trimmed === "cron" ? "nested" : trimmed;
  }),
  resolveThinkingDefaultMock: vi.fn(() => "off"),
  runEmbeddedPiAgentMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(
    async ({
      provider,
      model,
      run,
    }: {
      provider: string;
      model: string;
      run: (provider: string, model: string) => Promise<unknown>;
    }) => ({
      result: await run(provider, model),
      provider,
      model,
    }),
  ),
}));

export { resolveThinkingDefaultMock };

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

vi.mock("../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-selection.js")>(
    "../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: vi.fn(() => false),
    runWithModelFallback: runWithModelFallbackMock,
  };
});

vi.mock("./isolated-agent/run.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./isolated-agent/run.runtime.js")>(
    "./isolated-agent/run.runtime.js",
  );
  return {
    ...actual,
    resolveThinkingDefault: resolveThinkingDefaultMock,
  };
});

vi.mock("./isolated-agent/run-embedded.runtime.js", () => ({
  resolveFastModeState: resolveFastModeStateMock,
  resolveNestedAgentLane: resolveNestedAgentLaneMock,
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
}));

vi.mock("./isolated-agent/run-execution.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./isolated-agent/run-execution.runtime.js")>(
    "./isolated-agent/run-execution.runtime.js",
  );
  return {
    ...actual,
    isCliProvider: vi.fn(() => false),
  };
});

vi.mock("../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

export const makeIsolatedAgentJob = makeIsolatedAgentJobFixture;
export const makeIsolatedAgentParams = makeIsolatedAgentParamsFixture;
