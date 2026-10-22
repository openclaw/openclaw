import { afterEach, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { withPreparedEmbeddedGatewayTools } from "../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startGitHubPublicationDiscovery } from "./github-publication-discovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareGitHubPublicationFact } from "./worker-environments/worker-github-binding.js";

// mock-isolation: Fixed credential/workspace I/O; discovery and turn tool selection are real.
vi.mock("./worker-environments/worker-github-binding.js", () => ({
  prepareGitHubPublicationFact: vi.fn(async () => ({ available: true })),
}));

afterEach(() => clearRuntimeConfigSnapshot());

it.each([
  { label: "managed", expected: true },
  { label: "standalone", expected: false },
  { label: "local embedded", localEmbedded: true, expected: false },
  { label: "detached", sessionPersistence: "detached" as const, expected: false },
  { label: "tools disabled", disableTools: true, expected: false },
  { label: "non-OpenClaw harness", harness: "external", expected: false },
])("offers cold publication only to managed Gateway tools: $label", async (scenario) => {
  setRuntimeConfigSnapshot({});
  const clock = createGatewaySchedulerClock(1_000);
  const scheduler = createTestGatewayScheduler(clock.clock);
  const discovery = startGitHubPublicationDiscovery({ scheduler });
  const admission = prepareSystemAgentRunAdmission(
    {},
    "publisher-first-turn",
    "main",
    "publication-test",
  );
  const admittedRunContext = await admission.admit("plugin-harness", "publication-test");
  const gateway = { localEmbedded: scenario.localEmbedded } as GatewayRequestContext;
  if (scenario.label !== "standalone") {
    bindGatewayContextResolver(admittedRunContext, () => gateway);
  }
  const attempt = {
    agentId: "main",
    sessionId: "synthetic-first-turn",
    sessionKey: "agent:main:synthetic-first-turn",
    agentHarnessId: scenario.harness ?? "openclaw",
    sessionPersistence: scenario.sessionPersistence,
    disableTools: scenario.disableTools,
    admittedRunContext,
    githubPublicationAvailable: undefined as boolean | undefined,
  };
  const tools = () =>
    withPreparedEmbeddedGatewayTools(attempt, async () =>
      createOpenClawTools({ githubPublicationAvailable: attempt.githubPublicationAvailable })
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("github_")),
    );
  try {
    const first = await tools();
    expect(first.includes("github_publish")).toBe(scenario.expected);
    expect(first.includes("github_identity_status")).toBe(scenario.expected);
    await clock.wake();
    expect(prepareGitHubPublicationFact).not.toHaveBeenCalled();
  } finally {
    admission.close();
    await discovery.stop();
    await scheduler.stop();
  }
});
