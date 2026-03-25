import { describe, expect, it } from "vitest";
import { __test__ } from "./register.thread.js";

describe("resolveThreadCreateAction", () => {
  it("maps telegram thread create to topic-create", () => {
    expect(__test__.resolveThreadCreateAction({ channel: "telegram" })).toBe("topic-create");
    expect(__test__.resolveThreadCreateAction({ channel: " Telegram " })).toBe("topic-create");
  });

  it("keeps thread-create for non-telegram channels", () => {
    expect(__test__.resolveThreadCreateAction({ channel: "discord" })).toBe("thread-create");
    expect(__test__.resolveThreadCreateAction({ channel: undefined })).toBe("thread-create");
  });
});
