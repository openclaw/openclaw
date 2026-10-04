// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { loadLocalAssistantIdentity } from "./assistant-identity.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("preserves July 2026 browser avatar overrides for each agent", () => {
  const storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
  const key = "openclaw.control.assistant.v1";
  const stored = JSON.stringify({
    avatars: { main: "data:image/png;base64,bWFpbg==", research: "data:image/png;base64,b3RoZXI=" },
  });
  storage.setItem(key, stored);

  expect(loadLocalAssistantIdentity({ agentId: "main" })).toEqual({
    agentId: "main",
    avatar: "data:image/png;base64,bWFpbg==",
  });
  expect(loadLocalAssistantIdentity({ agentId: "research" })).toEqual({
    agentId: "research",
    avatar: "data:image/png;base64,b3RoZXI=",
  });
  expect(storage.getItem(key)).toBe(stored);
});
