import { describe, expect, it, vi } from "vitest";
import { explainToolAvailability } from "./tool-availability-explanation.js";

// Agent (config-only) queries back Doctor; loading any of these modules fails the test.
// (cli-backends itself is reachable through config validation, a policy-wide dependency.)
const refuseLoad = vi.hoisted(() => (name: string) => () => {
  throw new Error(`agent query loaded ${name}`);
});
// mock-isolation: importing this module on the agent query path fails the test.
vi.mock("./tool-availability-session-gates.runtime.js", refuseLoad("session gates"));
// mock-isolation: importing this module on the agent query path fails the test.
vi.mock("./harness/selection.js", refuseLoad("harness selection"));
// mock-isolation: importing this module on the agent query path fails the test.
vi.mock("./cli-runner/prepare-claude.js", refuseLoad("CLI runner placement"));
// mock-isolation: importing this module on the agent query path fails the test.
vi.mock("./model-runtime-aliases.js", refuseLoad("CLI runtime aliases"));
// mock-isolation: importing this module on the agent query path fails the test.
vi.mock("./tools-effective-inventory.js", refuseLoad("effective tool inventory"));

describe("explainToolAvailability agent queries", () => {
  it("explain configured policy without loading session, harness or CLI modules", async () => {
    const report = await explainToolAvailability({
      config: {
        agents: {
          entries: { main: { tools: { profile: "messaging" } } },
          defaults: { model: { primary: "openai/gpt-5.5" } },
        },
      },
      agentId: "main",
      toolNames: ["web_fetch"],
    });
    expect(report.tools[0]).toMatchObject({ available: false, block: { stage: "profile" } });
  });
});
