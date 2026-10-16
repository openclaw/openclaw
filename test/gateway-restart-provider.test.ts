import { expect, it } from "vitest";
import { startGatewayRestartProvider } from "./helpers/gateway-restart-provider.js";

it("distinguishes current recovery and exec-loss inputs from session history", async ({
  signal,
}) => {
  const provider = await startGatewayRestartProvider(signal);
  const user = (text: string) => ({
    role: "user",
    content: [{ type: "input_text", text }],
  });
  const initial = user("RESTART_HANDOFF_0: keep the model request pending.");
  const recovery = user("Your previous turn was interrupted by a gateway restart.");
  const lost = user(
    "Exec lost (fixture, service): the process was lost when the Gateway restarted.",
  );
  const recovered = {
    role: "assistant",
    content: [{ type: "output_text", text: "RESTART_HANDOFF_RESUMED_0" }],
  };
  provider.beginRecovery();
  provider.releaseRecovery();
  try {
    for (const { input, expected, excluded } of [
      {
        input: [initial, recovery],
        expected: "RESTART_HANDOFF_RESUMED_0",
        excluded: "RESTART_HANDOFF_EXEC_LOST_0",
      },
      {
        input: [initial, recovery, recovered, lost],
        expected: "RESTART_HANDOFF_EXEC_LOST_0",
        excluded: "RESTART_HANDOFF_RESUMED_0",
      },
      {
        input: [initial, lost, recovery],
        expected: "RESTART_HANDOFF_RESUMED_0",
        excluded: "RESTART_HANDOFF_EXEC_LOST_0",
      },
    ]) {
      const response = await fetch(`${provider.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true, tools: [{ type: "function", name: "exec" }], input }),
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
