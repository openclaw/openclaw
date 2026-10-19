import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";

export function progressSubmitScenario(activeRun = false) {
  const sessionKey = "agent:main:main";
  return {
    sessionKey,
    agentModel: "example/demo-model",
    models: [{ id: "demo-model", name: "Demo model", provider: "example", contextWindow: 128000 }],
    sessionInfo: {
      key: sessionKey,
      hasActiveRun: activeRun,
      activeRunIds: activeRun ? ["existing-run"] : [],
      status: activeRun ? "running" : "done",
    },
    ...(activeRun
      ? { inFlightRun: { runId: "existing-run", text: "Checking the workspace." } }
      : {}),
    historyMessages: Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `Review note ${index + 1}. The workspace is ready.` }],
      timestamp: index + 1,
    })),
    featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
    deferredMethods: ["chat.send"],
    methodResponses: {
      "progressCard.get": {
        card: {
          sessionKey,
          revision: 1,
          updatedAt: 1,
          markdown: "Reviewing the synthetic workspace.",
          steps: [
            { step: "Inspect the workspace", status: "completed" },
            { step: "Verify the progress card", status: "in_progress" },
            { step: "Summarize the result", status: "pending" },
          ],
        },
      },
    },
  } satisfies ControlUiMockGatewayScenario;
}
