import { beforeEach, expect, it, vi } from "vitest";
import type { preparePublishedModelRuntimeChoice } from "../../agents/model-runtime-choice.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { expectRpcError, expectRpcResult } from "./rpc-response.test-support.js";

const fixture = vi.hoisted(() => {
  const config: OpenClawConfig = {};
  return {
    config,
    beforeWrite: () => {},
    current: true,
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
  fixture.beforeWrite = () => {};
  fixture.current = true;
  fixture.choice.mockReset().mockImplementation(async ({ runtimeId }) => ({
    kind: "ready",
    runtimeId: runtimeId ?? "openclaw",
    validate: () => (fixture.current ? undefined : "Replaced"),
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
    expectRpcResult(await update(request), { ok: true, agentId: "main" });
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
  fixture.beforeWrite = () => {
    fixture.current = false;
  };
  expectRpcError(await update(request), { message: "Replaced" });
  expect(fixture.config).toEqual(before);
});
