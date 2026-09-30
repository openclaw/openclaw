// Tests user-facing pairing messages and setup command copy.
import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { buildPairingReply } from "./pairing-messages.js";

describe("buildPairingReply", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_CONTAINER_HINT", "OPENCLAW_PROFILE"]);
    delete process.env.OPENCLAW_CONTAINER_HINT;
    process.env.OPENCLAW_PROFILE = "isolated";
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("formats the pairing reply with a profile-aware approval command", () => {
    const params = {
      channel: "telegram",
      idLine: "Your Telegram user id: 42",
      code: "QRS678",
    };
    const text = buildPairingReply(params);
    expectPairingReplyText(text, params);
    expect(text).toContain("openclaw --profile isolated pairing approve telegram QRS678");
    expect(text.match(/pairing approve telegram QRS678/g)).toHaveLength(1);
  });
});
