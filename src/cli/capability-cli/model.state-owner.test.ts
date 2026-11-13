import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { useLocalStateOwnerFixture } from "../local-state-owner.fixture.test-support.js";
import { registerModelCapabilityCommands } from "./model.js";

const local = vi.hoisted(() => ({ admitted: vi.fn() }));
// mock-isolation: Local credential admission is the effect under test; it can refresh OAuth.
vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: local.admitted,
  completeWithPreparedSimpleCompletionModel: local.admitted,
}));

const fixture = useLocalStateOwnerFixture();
const agentRequests: Record<string, unknown>[] = [];

beforeEach(async () => {
  local.admitted.mockReset().mockRejectedValue(new Error("local credential admission"));
  agentRequests.length = 0;
  fixture.handlers.agent = ({ params, respond }) => {
    agentRequests.push(params);
    respond(true, {
      status: "ok",
      result: {
        payloads: [{ text: "gateway-ok" }],
        meta: { agentMeta: { provider: "fixture", model: "oauth-model" } },
      },
    });
  };
  await fixture.startOwner();
});

function runModel(...options: string[]) {
  const command = new Command();
  registerModelCapabilityCommands(command);
  return command.parseAsync(
    ["model", "run", "--prompt", "hello", "--model", "fixture/oauth-model", "--json", ...options],
    { from: "user" },
  );
}

it("runs infer model run through the Gateway that owns the shared credentials", async () => {
  await runModel();

  expect(local.admitted).not.toHaveBeenCalled();
  expect(fixture.transport.request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ method: "agent", expectFinal: true, localPortOverride: 18789 }),
  );
  expect(agentRequests).toEqual([
    expect.objectContaining({
      provider: "fixture",
      model: "oauth-model",
      modelRun: true,
      promptMode: "none",
    }),
  ]);
  expect(JSON.parse(fixture.output)).toMatchObject({
    transport: "gateway",
    outputs: [{ text: "gateway-ok" }],
  });
});

it("refuses an explicit --local run while the Gateway owns the shared credentials", async () => {
  await expect(runModel("--local")).rejects.toMatchObject({
    code: "OWNER_UNAVAILABLE",
    message: expect.stringContaining("Omit --local to run it through the Gateway."),
  });
  expect(local.admitted).not.toHaveBeenCalled();
  expect(fixture.transport.request).not.toHaveBeenCalled();
});
