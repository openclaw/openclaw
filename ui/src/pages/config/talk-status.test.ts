import { expect, it } from "vitest";
import { talkProviderStatus } from "./talk-status.ts";

it("uses the group's ready for the active provider and configured for the rest", () => {
  const group = { ready: false, activeProvider: "openai" };
  expect(talkProviderStatus(group, { id: "openai", configured: true })).toBe("notReady");
  expect(talkProviderStatus({ ...group, ready: true }, { id: "openai", configured: true })).toBe(
    "ready",
  );
  expect(talkProviderStatus(group, { id: "xai", configured: true })).toBe("configured");
  expect(talkProviderStatus(group, { id: "xai", configured: false })).toBe("notConfigured");
});

it("falls back to configured when the catalog omits ready", () => {
  expect(talkProviderStatus({ activeProvider: "openai" }, { id: "openai", configured: true })).toBe(
    "configured",
  );
  expect(talkProviderStatus(undefined, { id: "openai", configured: false })).toBe("notConfigured");
});
