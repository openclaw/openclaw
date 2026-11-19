import { expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { readGroupParticipationEvidence } from "./group-participation-context.js";
import { fixture } from "./group-participation.runner.test-support.js";

it("does not classify a textless source as a negative attention judgment", async () => {
  const recorder = createUserTurnTranscriptRecorder({ input: {}, target: () => undefined });
  vi.spyOn(recorder, "resolveMessage").mockResolvedValue({
    role: "user",
    content: [{ type: "image", data: "image-data", mimeType: "image/png" }],
    timestamp: 1,
  });
  expect(
    await readGroupParticipationEvidence({
      agentId: "main",
      target: {
        agentId: "main",
        sessionId: "media-only",
        sessionKey: "agent:main:telegram:group:-10115",
        storePath: fixture.storePath,
      },
      recorder,
      signal: new AbortController().signal,
      timeoutMs: 30_000,
    }),
  ).toBeUndefined();
});

it.each(["deadline", "cancel"] as const)(
  "bounds pending evidence acquisition on %s",
  async (kind) => {
    const recorder = createUserTurnTranscriptRecorder({ input: {}, target: () => undefined });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(recorder, "resolveMessage").mockImplementation(async () => {
      await blocked;
      return undefined;
    });
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const pending = readGroupParticipationEvidence({
        agentId: "main",
        target: {
          agentId: "main",
          sessionId: "blocked-source",
          sessionKey: "agent:main:telegram:group:-10117",
          storePath: fixture.storePath,
        },
        recorder,
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      if (kind === "cancel") {
        const failure = new Error("Turn cancelled");
        const assertion = expect(pending).rejects.toBe(failure);
        controller.abort(failure);
        await assertion;
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toBeUndefined();
        expect(controller.signal.aborted).toBe(false);
      }
    } finally {
      release();
      await blocked;
      vi.useRealTimers();
    }
  },
);
