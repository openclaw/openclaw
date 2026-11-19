import { afterEach, beforeEach, vi } from "vitest";
import type { DecisionProviderV1 } from "../../decisions/provider-types.js";
import { registered } from "../../decisions/runtime.test-support.js";
import { createGroupReplyFixture } from "./group-participation.reply.test-support.js";

const models = vi.hoisted(() => ({
  embedded: vi.fn<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>(),
  cli: vi.fn<typeof import("../../agents/cli-runner.js").runCliAgent>(),
  decision: vi.fn<DecisionProviderV1["evaluate"]>(),
}));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: models.embedded,
}));
vi.mock("../../agents/cli-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/cli-runner.js")>()),
  runCliAgent: models.cli,
}));

export { models };

export let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
afterEach(async () => {
  await fixture.close();
});
beforeEach(async () => {
  fixture = await createGroupReplyFixture();
  models.embedded.mockReset();
  models.cli.mockReset();
  models.decision.mockReset();
  fixture.config.agents!.defaults!.experimental = { decisionAssistance: true };
  const { registry } = registered(async (...args) => {
    const outcome = await models.decision(...args);
    return outcome.status === "ok" ? { status: "ok", result: outcome.result } : outcome;
  });
  registry.cliBackends.push({
    pluginId: "synthetic-cli",
    source: "test",
    backend: { id: "fixture-cli", config: { command: "synthetic-cli" }, bundleMcp: false },
  });
});
