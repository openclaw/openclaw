import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { scheduleTranscriptsSidecar } from "./server-startup-transcripts.js";
import { transcriptSidecarMocks as mocks } from "./server-startup-transcripts.test-support.js";

const stateDir = path.resolve("synthetic-transcript-sidecar");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  resetGatewayWorkAdmission();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetGatewayWorkAdmission();
});

it.each([false, true])(
  "joins transcript shutdown failures and keeps the exact Gateway fenced (configured: %s)",
  async (configured) => {
    const started = createDeferred();
    const manualStopped = createDeferred();
    const manualFailure = new Error("manual capture stop failed");
    const configuredFailure = new Error("configured capture stop failed");
    if (configured) {
      mocks.transcriptsAutoStartService.start.mockImplementationOnce(() => started.resolve());
      mocks.transcriptsAutoStartService.stop.mockRejectedValueOnce(configuredFailure);
    }
    mocks.transcriptCapturePolicy.drain.mockImplementationOnce(() => manualStopped.promise);
    const config: OpenClawConfig = {
      transcripts: {
        autoStart: configured
          ? [{ providerId: "discord-voice", guildId: "g", channelId: "c" }]
          : [],
      },
    };
    const lifetime = new AbortController();
    const registry = createEmptyPluginRegistry();
    const sidecar = scheduleTranscriptsSidecar({
      cfg: config,
      getConfig: () => config,
      getPluginRegistry: () => registry,
      lifetimeSignal: lifetime.signal,
      log: { warn: vi.fn() },
    });
    let stopped: Promise<unknown> | undefined;
    try {
      if (configured) {
        await vi.runAllTimersAsync();
        await vi.dynamicImportSettled();
        await started.promise;
      }
      let settled = false;
      stopped = Promise.resolve(sidecar.stop())
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await vi.dynamicImportSettled();
      expect(mocks.prepareTranscriptCaptureDisable).toHaveBeenCalledWith(stateDir);
      expect(mocks.transcriptCapturePolicy.drain).toHaveBeenCalledTimes(1);
      expect(mocks.transcriptsAutoStartService.stop).toHaveBeenCalledTimes(configured ? 1 : 0);
      expect(settled).toBe(false);
      manualStopped.reject(manualFailure);
      await expect(stopped).resolves.toMatchObject({
        errors: configured ? [configuredFailure, manualFailure] : [manualFailure],
      });
      expect(mocks.transcriptCapturePolicy.resume).not.toHaveBeenCalled();

      await sidecar.stop();
      expect(mocks.prepareTranscriptCaptureDisable).toHaveBeenCalledTimes(1);
      expect(mocks.transcriptCapturePolicy.drain).toHaveBeenCalledTimes(2);
      lifetime.abort();
      expect(mocks.transcriptCapturePolicy.resume).toHaveBeenCalledTimes(1);
    } finally {
      manualStopped.resolve();
      await stopped;
      await sidecar.stop();
      lifetime.abort();
    }
  },
);
