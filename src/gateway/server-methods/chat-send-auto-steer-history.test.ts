import { expect, it } from "vitest";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import { readSessionHistoryPageInWorker } from "../../config/sessions/session-history-worker-runtime.js";
import { installGatewayTestHooks } from "../test-helpers.js";
import { projectAutoSteerEvidence } from "./chat-send-auto-steer-evidence.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
installGatewayTestHooks({ scope: "suite" });
const createFixture = useBrowserFollowupFixture();
it("projects the exact source through the actual bounded history worker", async () => {
  const fixture = await createFixture({ preserveContent: true });
  try {
    for (const message of [
      { role: "user", content: "Unrelated earlier task", timestamp: 1 },
      {
        role: "user",
        content: "Current visible task",
        timestamp: 2,
        idempotencyKey: "history-source:user",
      },
      {
        role: "user",
        content: "Hidden coordination",
        timestamp: 3,
        display: false,
        provenance: { kind: "internal_system" },
      },
      { role: "user", content: "Visible refinement", timestamp: 4 },
    ]) {
      await appendTranscriptMessage(fixture.scope, { message });
    }
    const page = await readSessionHistoryPageInWorker({
      kind: "rpc",
      params: {
        entry: undefined,
        provider: undefined,
        sessionId: fixture.scope.sessionId,
        storePath: fixture.scope.storePath,
        sessionAgentId: fixture.scope.agentId,
        canonicalKey: fixture.scope.sessionKey,
        max: 12,
        maxHistoryBytes: 32_000,
        effectiveMaxChars: 12_000,
        offset: undefined,
        messageId: undefined,
        ignoreCliSessionImports: true,
      },
    });
    expect(projectAutoSteerEvidence(page.messages, "history-source", "Handle tabs.")).toEqual({
      currentTurn: [
        { role: "user", text: "Current visible task" },
        { role: "user", text: "Visible refinement" },
      ],
      newMessage: "Handle tabs.",
    });
    expect(
      projectAutoSteerEvidence(page.messages, "missing-source", "Handle tabs."),
    ).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});
