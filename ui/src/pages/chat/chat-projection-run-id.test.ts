/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import * as chatThread from "./chat-thread.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { ChatThread } from "./components/chat-thread-view.tsx";
import { threadProps } from "./components/chat-transcript.test-support.ts";
import { resolveChatProjectionRunId } from "./tool-stream-snapshot.ts";

describe("resolveChatProjectionRunId", () => {
  it("restores only an active run proven by the reconnecting outbox", () => {
    const reconnecting = {
      id: "reconnecting",
      text: "Current prompt",
      createdAt: 1,
      sendRunId: "run-restored",
      sendState: "waiting-reconnect" as const,
    };

    expect(
      resolveChatProjectionRunId({
        activeRunIds: ["run-restored"],
        queue: [reconnecting],
      }),
    ).toBe("run-restored");
    expect(
      resolveChatProjectionRunId({
        activeRunIds: ["run-stale"],
        queue: [reconnecting],
      }),
    ).toBeNull();
    expect(
      resolveChatProjectionRunId({
        localRunId: "run-local",
        activeRunIds: ["run-restored"],
        queue: [reconnecting],
      }),
    ).toBe("run-local");
  });
});

describe("transcript run identity", () => {
  it("does not project a session row's first active run without an explicit run id", () => {
    const build = vi.spyOn(chatThread, "buildCachedChatItems").mockReturnValue([]);

    const container = document.body.appendChild(document.createElement("div"));
    const transcript = createTestTranscript();
    onTestFinished(() => {
      view.unmount();
      transcript.dispose();
      container.remove();
    });
    const view = mountSolid(
      () =>
        createComponent(ChatThread, {
          props: {
            ...threadProps("run-id-projection"),
            sessions: {
              ts: 0,
              path: "",
              count: 1,
              defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
              sessions: [
                {
                  key: "agent:main:main",
                  kind: "direct",
                  updatedAt: 1,
                  hasActiveRun: true,
                  activeRunIds: ["arbitrary-first", "other-run"],
                },
              ],
            },
          },
          transcript,
        }),
      { container },
    );
    flush();
    transcript.start();
    transcript.update();
    flush();

    expect(build).toHaveBeenCalledWith(expect.objectContaining({ runId: null }));
  });
});
