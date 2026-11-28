import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendTalkConsultStopTranscript } from "./consult-stop-transcript.js";
import {
  buildTalkRealtimeHistoryInstructions,
  readTalkRealtimeInitialItems,
} from "./session-history.js";

it("stores one model-visible Talk Stop entry even if the receipt is replayed", () =>
  withOpenClawTestState({ label: "talk-stop-transcript", scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "talk-stop-session",
      storePath: state.statePath("sessions.json"),
    };
    setRuntimeConfigSnapshot({});
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
    const stop = { ...target, runId: "consult-1" };
    await appendTalkConsultStopTranscript(stop);
    await appendTalkConsultStopTranscript(stop);
    const message = "The user stopped this task. Do not retry unless the user asks again.";
    expect(
      (await loadTranscriptEvents(target)).filter(
        (entry) => asOptionalRecord(entry)?.type === "message",
      ),
    ).toMatchObject([
      { message: { role: "assistant", content: [{ type: "text", text: message }] } },
    ]);
    const history = await readTalkRealtimeInitialItems(
      { ...target, canonicalKey: target.sessionKey, assertCurrent: () => {} },
      () => {},
    );
    expect(history).toEqual([{ role: "assistant", text: message }]);
    expect(buildTalkRealtimeHistoryInstructions(history)).toContain(
      JSON.stringify([{ role: "assistant", text: message }]),
    );
  }));
