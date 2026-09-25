import { expect, test } from "vitest";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import { createChatMetadataHarness } from "./chat-metadata-runtime.test-support.js";

test("prepares chat metadata for healthy agents while reporting a refused agent", async () => {
  const harness = createChatMetadataHarness({
    agents: { entries: { main: { default: true }, cleaner: {} } },
  });
  const owner = harness.getPreparedOwner();
  harness.getPreparedOwner.mockImplementation((params) =>
    params?.agentId === "cleaner" ? undefined : owner,
  );
  const reason = "Refused agent cleaner: its database belongs to main.";
  recordAgentDatabaseAdmissions([
    {
      agentId: "cleaner",
      paths: ["/synthetic/cleaner/openclaw-agent.sqlite"],
      embeddedOwnerId: "main",
      code: "agent-database-ownership-mismatch",
      reason,
      repairHint: "Inspect the copy, then restart.",
    },
  ]);
  try {
    await harness.runtime.refresh();
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "first" })],
    });
    await expect(harness.runtime.read({ agentId: "cleaner" })).rejects.toThrow(reason);
    await expect(harness.runtime.readStartup({ agentId: "cleaner" })).rejects.toThrow(reason);
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);
  } finally {
    await harness.runtime.stop();
    recordAgentDatabaseAdmissions([]);
  }
});
