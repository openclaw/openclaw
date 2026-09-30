import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import type { prepareModelChoice } from "../model-runtime-choice.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

const hoisted = vi.hoisted(() => ({ prepareModelChoiceMock: vi.fn<typeof prepareModelChoice>() }));
vi.mock("../subagents/spawn/subagent-spawn.runtime.js", () => ({
  prepareModelChoice: hoisted.prepareModelChoiceMock,
}));
vi.mock("../subagents/registry/subagent-registry.js", () => ({
  registerSubagentRun: vi.fn(),
}));

it("rejects an unsupported visible model before creating a session or registering a run", async () => {
  await withTestDir({ prefix: "openclaw-visible-model-" }, async (dir) => {
    const callGateway = vi.fn(async () => {
      throw new Error("Unexpected Gateway creation");
    });
    const registerRun = vi.fn();
    hoisted.prepareModelChoiceMock.mockResolvedValue({
      kind: "unavailable",
      error: "Unknown model: xai/nonexistent-native-fixture",
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        session: { store: path.join(dir, "sessions.json") },
        agents: { entries: { main: { workspace: dir } } },
      },
      callGateway,
      registerRun,
      countActiveRuns: () => 0,
    });
    const result = await tool.execute("unsupported-visible", {
      task: "validate the selected model",
      model: "xai/nonexistent-native-fixture",
      visible: true,
    });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("Unknown model"),
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(registerRun).not.toHaveBeenCalled();
    expect(hoisted.prepareModelChoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "xai/nonexistent-native-fixture", source: "override" }),
    );
  });
});

it.each([
  {
    name: "reports the human owner returned by visible session creation",
    actor: { type: "human", id: "profile-vito" },
    identity: undefined,
    owner: { type: "human", id: "profile-vito" },
  },
  {
    name: "preserves the configured agent label for an ID-only stored owner",
    actor: { type: "agent", id: "main" },
    identity: { name: "Roboclaw" },
    owner: { type: "agent", id: "main", label: "Roboclaw" },
  },
])("$name", async ({ actor, identity, owner }) => {
  hoisted.prepareModelChoiceMock.mockResolvedValue({
    kind: "automatic",
    ref: { provider: "mock-provider", model: "primary" },
  });
  const gateway = { call: callInProcessGatewayTool };
  vi.spyOn(gateway, "call").mockResolvedValue({
    key: "agent:main:dashboard:owned-child",
    runStarted: true,
    runId: "run-visible",
    entry: { owner: { actor } },
  });
  const tool = createSessionsSpawnTool({
    agentSessionKey: "agent:main:main",
    config: {
      agents: {
        defaults: { model: "mock-provider/primary" },
        entries: { main: { identity } },
      },
    },
    callGateway: gateway.call,
    registerRun: vi.fn(),
    countActiveRuns: () => 0,
  });

  const result = await tool.execute("owned-visible", {
    task: "inspect the repository",
    visible: true,
  });

  expect(result.details).toMatchObject({
    status: "accepted",
    owner,
  });
});

it("reports every unsupported visible parameter in one error", async () => {
  const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

  await expect(
    tool.execute("visible-unsupported-many", {
      task: "inspect",
      runtime: "acp",
      thinking: "high",
      thread: true,
      mode: "session",
      lightContext: true,
      attachments: [{ name: "note.txt", content: "hello" }],
      attachAs: { mountPath: "inputs" },
      visible: true,
    }),
  ).rejects.toThrow(
    'Parameters unavailable with visible=true: runtime: supports runtime="subagent" only; thinking: thinking overrides are not wired to the sessions.create path; thread: visible sessions route to the dashboard, not a channel thread; mode: visible sessions are persistent dashboard sessions; lightContext: bootstrap staging is not wired to the sessions.create path; attachments: attachment staging is not wired to the sessions.create path; attachAs: attachment staging is not wired to the sessions.create path',
  );
});
