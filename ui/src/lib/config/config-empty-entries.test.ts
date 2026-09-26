// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
  createConfigServerMock,
} from "./config-test-harness.ts";

it("keeps a new empty map entry through autosave, later editing, and reload", async () => {
  vi.useFakeTimers();
  const server = createConfigServerMock();
  const { runtimeConfig } = createConfigCapabilityHarness(
    server.request as GatewayBrowserClient["request"],
  );
  try {
    await runtimeConfig.ensureLoaded();

    // Add Entry commits the schema-valid empty object before the user types.
    runtimeConfig.patchForm(["talk", "providers"], { "custom-1": {} });
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(server.submissions).toHaveLength(1);
    expect(JSON.parse(server.submissions[0]!.raw)).toEqual({
      count: 1,
      talk: { providers: { "custom-1": {} } },
    });
    expect(runtimeConfig.state.configForm).toEqual({
      count: 1,
      talk: { providers: { "custom-1": {} } },
    });

    runtimeConfig.patchForm(["talk", "providers", "custom-1", "voiceId"], "fixture-voice");
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    await runtimeConfig.refresh();
    expect(runtimeConfig.state.configForm).toEqual({
      count: 1,
      talk: { providers: { "custom-1": { voiceId: "fixture-voice" } } },
    });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
  } finally {
    runtimeConfig.dispose();
  }
});
