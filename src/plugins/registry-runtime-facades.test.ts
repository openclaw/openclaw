import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { getPluginInstance } from "./plugin-instance-scope.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "./registry-lifecycle.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";

it.each([false, true])(
  "preserves optional stream availability and owner scope: %s",
  async (available) => {
    const runtime = createPluginRuntime();
    if (available) {
      runtime.mediaUnderstanding.transcribeAudioStream = async () => ({
        supported: true,
        text: getPluginRuntimeGatewayRequestScope()?.pluginId ?? "unscoped",
        no_speech: false,
        mode: "realtime",
        provider: "fixture",
      });
    } else {
      delete runtime.mediaUnderstanding.transcribeAudioStream;
    }
    const builder = createRuntimeTestRegistry(runtime);
    const record = createOwnershipRecord("optional-stream");
    const api = builder.createApi(record, { config: {} });
    const owner = expectDefined(getPluginInstance(record), "plugin instance");
    markPluginRegistryActive(builder.registry);
    try {
      const stream = api.runtime.mediaUnderstanding.transcribeAudioStream;
      if (!available) {
        expect(stream).toBeUndefined();
        return;
      }
      const retained = expectDefined(stream, "stream capability");
      const request = {
        cfg: {},
        agentId: "main",
        format: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } as const,
        audio: (async function* () {
          yield Buffer.alloc(2);
        })(),
        signal: new AbortController().signal,
      };
      await expect(retained(request)).resolves.toMatchObject({ text: "optional-stream" });
      revokePluginRecord(builder.registry, record);
      expect(() => retained(request)).toThrow("runtime is no longer active");
    } finally {
      await owner.dispose();
      markPluginRegistryRetired(builder.registry);
    }
  },
);
