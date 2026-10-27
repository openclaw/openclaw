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
// mock-isolation: Control catalog ownership without activating model runtimes.
vi.mock("../../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: async ({
    runtimeId,
  }: Parameters<typeof preparePublishedModelRuntimeChoice>[0]): ReturnType<
    typeof preparePublishedModelRuntimeChoice
  > => ({
    kind: "ready",
    runtimeId: runtimeId ?? "openclaw",
    validate: () => (fixture.current ? undefined : "Replaced"),
  }),
}));

const { agentsHandlers } = await import("./agents.js");
function update(params: Record<string, unknown>) {
  return callAgentHandler(agentsHandlers["agents.update"]!, "agents.update", params, {
    context: createDirectChatContext({ getRuntimeConfig: () => fixture.config }),
  });
}

beforeEach(() => {
  fixture.config = { agents: { entries: { main: {} } } };
  fixture.beforeWrite = () => {};
  fixture.current = true;
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
    const selection = {
      model,
      models: { [model]: { agentRuntime: { id: "acp-opencode" } } },
    };
    expect(fixture.config).toEqual({
      ...(implicit ? { meta: { migrations: { modelPolicyAllowlist: true } } } : {}),
      agents: implicit ? { defaults: selection } : { defaults: {}, entries: { main: selection } },
    });
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
