import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { createGroupReplyFixture } from "./group-participation.reply.test-support.js";

const models = vi.hoisted(() => ({
  embedded: vi.fn<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>(),
  cli: vi.fn<typeof import("../../agents/cli-runner.js").runCliAgent>(),
  decision: vi.fn<typeof import("../../decisions/runtime.js").evaluateDecision>(),
}));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: models.embedded,
}));
vi.mock("../../agents/cli-runner.js", () => ({ runCliAgent: models.cli }));
vi.mock("../../decisions/runtime.js", () => ({ evaluateDecision: models.decision }));

let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
beforeAll(async () => {
  fixture = await createGroupReplyFixture();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(() => {
  models.embedded.mockReset();
  models.cli.mockReset();
  models.decision.mockReset();
  const registry = createTestRegistry();
  registry.cliBackends.push({
    pluginId: "synthetic-cli",
    source: "test",
    backend: { id: "fixture-cli", config: { command: "synthetic-cli" }, bundleMcp: false },
  });
  setActivePluginRegistry(registry);
});

it("keeps a selected generic CLI turn ordinary without a participation decision", async () => {
  fixture.config.agents!.defaults!.model = { primary: "fixture-cli/test-model" };
  models.cli.mockResolvedValue({
    payloads: [{ text: "Ordinary CLI reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply("Bob, do you know the port?", "cli-source", "-10101");
  expect(reply).toMatchObject({ text: "Ordinary CLI reply." });
  expect(models.decision).not.toHaveBeenCalled();
  expect(models.embedded).not.toHaveBeenCalled();
  expect(models.cli).toHaveBeenCalledTimes(1);
  expect(models.cli.mock.calls[0]?.[0]).toMatchObject({ terminalReplyExpectation: "required" });
});

it("restores ordinary policy before a private embedded attempt falls back to CLI", async () => {
  fixture.config.agents!.defaults!.model = {
    primary: "test-provider/test-model",
    fallbacks: ["fixture-cli/test-model"],
  };
  models.decision.mockImplementation(async (batch) =>
    judgment(batch, { attention: "opportunity" }),
  );
  models.embedded.mockRejectedValue(
    new FailoverError("Synthetic provider outage", {
      reason: "rate_limit",
      provider: "test-provider",
      model: "test-model",
    }),
  );
  models.cli.mockResolvedValue({
    payloads: [{ text: "Ordinary fallback reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply("Bob, do you know the port?", "cli-fallback-source", "-10102");
  expect(reply).toMatchObject({ text: "Ordinary fallback reply." });
  expect(models.embedded).toHaveBeenCalledTimes(1);
  expect(models.embedded.mock.calls[0]?.[0]).toMatchObject({
    permissionMode: "read-only",
    terminalReplyExpectation: "optional",
  });
  expect(models.cli).toHaveBeenCalledTimes(1);
  expect(models.cli.mock.calls[0]?.[0]).toMatchObject({
    terminalReplyExpectation: "required",
    sourceReplyDeliveryMode: "automatic",
  });
});

it("keeps ordinary behavior when the initial Decision Model is unavailable", async () => {
  fixture.config.agents!.defaults!.model = { primary: "test-provider/test-model" };
  models.decision.mockResolvedValue({ status: "unavailable", reason: "overloaded" });
  models.embedded.mockResolvedValue({
    payloads: [{ text: "Ordinary embedded reply." }],
    meta: { durationMs: 1 },
  });
  const reply = await fixture.reply(
    "Bob, do you know the port?",
    "initial-outage-source",
    "-10103",
  );
  expect(Array.isArray(reply) ? reply : [reply]).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "Ordinary embedded reply." })]),
  );
  expect(models.embedded).toHaveBeenCalledTimes(1);
  expect(models.embedded.mock.calls[0]?.[0]).toMatchObject({
    terminalReplyExpectation: "required",
  });
  expect(models.embedded.mock.calls[0]?.[0].reviewSettledDraft).toBeUndefined();
  expect(models.embedded.mock.calls[0]?.[0].permissionMode).not.toBe("read-only");
  expect(models.cli).not.toHaveBeenCalled();
});
