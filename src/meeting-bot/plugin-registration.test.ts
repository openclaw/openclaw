import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { registerMeetingPluginRuntime } from "./plugin-registration.js";

const metadata = {
  id: "browser-meeting",
  name: "Browser meeting",
  disabledMessage: "Meeting disabled",
};

it("keeps disabled runtimes cold and supports plugins without a transcript source", async () => {
  const api = createTestPluginApi();
  const services = vi.spyOn(api, "registerService");
  const sources = vi.spyOn(api, "registerTranscriptSourceProvider");
  const runtime = { reconcileTranscriptPolicy: vi.fn(async () => {}) };
  const createRuntime = vi.fn(() => runtime);
  const config = { enabled: false };
  const ensure = registerMeetingPluginRuntime(api, config, { ...metadata, createRuntime });
  await expect(ensure()).rejects.toThrow("Meeting disabled");
  expect(createRuntime).not.toHaveBeenCalled();
  config.enabled = true;
  await expect(ensure()).resolves.toBe(runtime);
  await expect(ensure()).resolves.toBe(runtime);
  expect(createRuntime).toHaveBeenCalledOnce();
  expect(runtime.reconcileTranscriptPolicy).toHaveBeenCalledExactlyOnceWith(true);
  expect(services).not.toHaveBeenCalled();
  expect(sources).not.toHaveBeenCalled();
});

it("reports a registered source whose runtime lacks transcript methods", async () => {
  const api = createTestPluginApi();
  const sources = vi.spyOn(api, "registerTranscriptSourceProvider");
  registerMeetingPluginRuntime(
    api,
    { enabled: true },
    {
      ...metadata,
      createRuntime: () => ({}),
      transcriptSource: { id: "captions", name: "Live captions" },
    },
  );
  const stop = sources.mock.calls[0]?.[0].stop;
  assert.ok(stop);
  await expect(stop({ sessionId: "call", source: { providerId: "captions" } })).rejects.toThrow(
    "Browser meeting transcript source runtime is unavailable",
  );
});
