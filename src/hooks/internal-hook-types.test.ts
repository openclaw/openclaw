// Internal hook event key validation tests.
import { describe, expect, it } from "vitest";
import {
  isKnownInternalHookEventKey,
  KNOWN_INTERNAL_HOOK_EVENT_KEYS,
} from "./internal-hook-types.js";

describe("isKnownInternalHookEventKey", () => {
  it("accepts every emitted type:action key", () => {
    for (const key of KNOWN_INTERNAL_HOOK_EVENT_KEYS) {
      expect(isKnownInternalHookEventKey(key), key).toBe(true);
    }
  });

  it("accepts bare family keys that subscribe to every action", () => {
    for (const family of ["command", "session", "agent", "gateway", "message"]) {
      expect(isKnownInternalHookEventKey(family), family).toBe(true);
    }
  });

  it("rejects typos, bare actions, and unknown families", () => {
    for (const key of [
      "command:nwe",
      "message:recieved",
      "startup", // bare action without its family
      "gateway:started",
      "session:compact", // partial multi-segment action
      "webhook:received",
      "",
      "COMMAND:NEW",
    ]) {
      expect(isKnownInternalHookEventKey(key), key).toBe(false);
    }
  });
});
