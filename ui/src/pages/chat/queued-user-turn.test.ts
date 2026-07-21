import { describe, expect, it } from "vitest";
import {
  chatMessagesContainQueuedUserTurn,
  readMessageIdempotencyKey,
} from "./queued-user-turn.ts";

describe("queued user turn delivery proof", () => {
  it("reads idempotencyKey from gateway top-level and local __openclaw shapes", () => {
    expect(
      readMessageIdempotencyKey({
        role: "user",
        content: "hi",
        idempotencyKey: "run-1:user",
        __openclaw: { id: "a", seq: 1 },
      }),
    ).toBe("run-1:user");
    expect(
      readMessageIdempotencyKey({
        role: "user",
        content: "hi",
        __openclaw: { idempotencyKey: "run-2:user" },
      }),
    ).toBe("run-2:user");
  });

  it("matches gateway-shaped history user turns for queue retirement", () => {
    expect(
      chatMessagesContainQueuedUserTurn(
        [
          {
            role: "user",
            content: "Use Cursor ACP",
            idempotencyKey: "abc:user",
            __openclaw: { id: "1", seq: 2 },
          },
        ],
        {
          id: "q1",
          text: "Use Cursor ACP",
          createdAt: 1,
          sendRunId: "abc",
        },
      ),
    ).toBe(true);
  });
});
