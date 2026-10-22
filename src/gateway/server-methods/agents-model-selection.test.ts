import { beforeEach, expect, it, vi } from "vitest";
import type { preparePublishedModelRuntimeChoice } from "../../agents/model-runtime-choice.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";

const fixture = vi.hoisted(() => {
  const config: OpenClawConfig = {};
  return {
    config,
    writes: vi.fn(),
    beforeWrite: vi.fn(),
    choice: vi.fn<typeof preparePublishedModelRuntimeChoice>(),
  };
});

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  mutateConfigFileWithRetry: async (params: {
    mutate: (draft: OpenClawConfig) => Promise<void>;
    writeOptions?: { assertConfigPathForWrite?: () => void };
  }) => {
    const draft = structuredClone(fixture.config);
    await params.mutate(draft);
    fixture.beforeWrite();
    params.writeOptions?.assertConfigPathForWrite?.();
    fixture.writes(draft);
    fixture.config = draft;
    if (params.writeOptions) {
      getRuntimeConfigWriteApplication(params.writeOptions)?.claim()?.settle("applied");
    }
  },
}));
vi.mock("../../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: fixture.choice,
}));

const { agentsHandlers } = await import("./agents.js");
function update(params: Record<string, unknown>) {
  return callAgentHandler(agentsHandlers["agents.update"]!, "agents.update", params, {
    context: createDirectChatContext({ getRuntimeConfig: () => fixture.config }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.config = { agents: { entries: { main: {} } } };
  fixture.beforeWrite.mockReset();
  fixture.choice.mockReset().mockImplementation(async ({ runtimeId }) => ({
    kind: "ready",
    runtimeId: runtimeId ?? "openclaw",
    validate: () => undefined,
  }));
});

const model = "acp-opencode/fixture-model";
const request = { agentId: "main", model, agentRuntime: "acp-opencode" };
it.each([false, true])(
  "persists the native default without inventing a roster (implicit=%s)",
  async (implicit) => {
    if (implicit) {
      fixture.config = {};
    }
    expect(await update(request)).toHaveBeenCalledWith(
      true,
      { ok: true, agentId: "main" },
      undefined,
    );
    expect(
      implicit ? fixture.config.agents?.defaults : fixture.config.agents?.entries?.main,
    ).toMatchObject({
      model,
      models: { [model]: { agentRuntime: { id: "acp-opencode" } } },
    });
    if (implicit) {
      expect(fixture.config.agents?.entries).toBeUndefined();
    }
    expect([fixture.config.auth, fixture.config.wizard]).toEqual([undefined, undefined]);
  },
);
it("rechecks catalog ownership at the final config write", async () => {
  const before = structuredClone(fixture.config);
  let current = true;
  fixture.choice.mockResolvedValue({
    kind: "ready",
    runtimeId: "acp-opencode",
    validate: () => (current ? undefined : "Replaced"),
  });
  fixture.beforeWrite.mockImplementation(() => {
    current = false;
  });
  expect(await update(request)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: "Replaced" }),
  );
  expect(fixture.writes).not.toHaveBeenCalled();
  expect(fixture.config).toEqual(before);
});
