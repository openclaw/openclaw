import { expect, it } from "vitest";
import { startGatewayRestartProvider } from "./helpers/gateway-restart-provider.js";

it("distinguishes execution, recovery and exec-loss turns with trailing runtime context", async ({
  signal,
}) => {
  const provider = await startGatewayRestartProvider(signal);
  const user = (text: string) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
  const initial = user("RESTART_HANDOFF_0: keep the model request pending.");
  const recovery = user("Your previous turn was interrupted by a gateway restart.");
  const lost = user(
    "Exec lost (fixture, service): the process was lost when the Gateway restarted.",
  );
  const recovered = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "RESTART_HANDOFF_RESUMED_0" }],
  };
  const runtimeContext = user(
    "OpenClaw runtime context:\nCurrent time: 2026-10-15 12:00 UTC\nEnd OpenClaw runtime context.",
  );
  const executionTools = [{ type: "function", name: "exec" }];
  try {
    const initialResponse = await fetch(`${provider.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        tools: executionTools,
        input: [initial, runtimeContext],
      }),
      signal,
    });
    expect(initialResponse.status).toBe(200);
    expect(await initialResponse.text()).toContain('"name":"exec"');
    provider.beginRecovery();
    provider.releaseRecovery();
    for (const { input, tools = executionTools, expected, excluded } of [
      {
        input: [initial, runtimeContext, recovery, runtimeContext],
        tools: [{ type: "function", name: "read" }],
        expected: "RESTART_HANDOFF_RESUMED_0",
        excluded: "Synthetic restart handoff session",
      },
      {
        input: [initial, recovery],
        expected: "RESTART_HANDOFF_RESUMED_0",
        excluded: "RESTART_HANDOFF_EXEC_LOST_0",
      },
      {
        input: [initial, runtimeContext, recovery, runtimeContext, recovered, lost, runtimeContext],
        expected: "RESTART_HANDOFF_EXEC_LOST_0",
        excluded: "RESTART_HANDOFF_RESUMED_0",
      },
      {
        input: [initial, lost, recovery],
        expected: "RESTART_HANDOFF_RESUMED_0",
        excluded: "RESTART_HANDOFF_EXEC_LOST_0",
      },
      {
        input: [initial, recovery, runtimeContext, recovered, user("Summarize this session.")],
        tools: [],
        expected: "Synthetic restart handoff session",
        excluded: "RESTART_HANDOFF_RESUMED_0",
      },
    ]) {
      const response = await fetch(`${provider.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true, tools, input }),
        signal,
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(expected);
      expect(text).not.toContain(excluded);
    }
  } finally {
    await provider.close();
  }
});
