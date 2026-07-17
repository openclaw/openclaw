import { describe, expect, it } from "vitest";
import { resolveControlUiFollowUpMode, resolveControlUiServerQueueMode } from "./follow-up-mode.js";

describe("Control UI follow-up mode", () => {
  it("matches webchat queue resolution precedence", () => {
    expect(resolveControlUiServerQueueMode({})).toBe("steer");
    expect(resolveControlUiServerQueueMode({ messages: { queue: { mode: "followup" } } })).toBe(
      "followup",
    );
    expect(
      resolveControlUiServerQueueMode({
        messages: { queue: { byChannel: { webchat: "collect" }, mode: "interrupt" } },
      }),
    ).toBe("collect");
    expect(
      resolveControlUiServerQueueMode(
        { messages: { queue: { byChannel: { webchat: "collect" }, mode: "interrupt" } } },
        "followup",
      ),
    ).toBe("followup");
    expect(resolveControlUiServerQueueMode(undefined, "followup")).toBe("followup");
  });

  it("inherits the server behavior until the browser has an explicit override", () => {
    expect(resolveControlUiFollowUpMode(undefined, undefined)).toBe("queue");
    expect(resolveControlUiFollowUpMode(undefined, "steer")).toBe("steer");
    expect(resolveControlUiFollowUpMode(undefined, "followup")).toBe("followup");
    expect(resolveControlUiFollowUpMode(undefined, "collect")).toBe("collect");
    expect(resolveControlUiFollowUpMode(undefined, "interrupt")).toBe("interrupt");
    expect(resolveControlUiFollowUpMode("queue", "steer")).toBe("queue");
    expect(resolveControlUiFollowUpMode("steer", "interrupt")).toBe("steer");
  });
});
