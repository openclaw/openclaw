import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  TtsDesignVoiceResultSchema,
  TtsReplicateVoiceResultSchema,
} from "../../../packages/gateway-protocol/src/schema/tts-voices.js";
import type { OpenClawConfig } from "../../config/types.js";
import { loadBundledCapabilityRuntimeRegistry } from "../../plugins/bundled-capability-runtime.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { handleGatewayRequest } from "../server-methods.js";

const dns = vi.hoisted(() => ({
  lookup: vi.fn<(hostname: string, options: { all: true }) => Promise<LookupAddress[]>>(),
}));

// The canonical plugin loader uses native imports, so intercept the Node DNS
// boundary itself instead of a Vitest-only module replacement.
function lookup(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
function lookup(hostname: string, options: LookupOneOptions | number): Promise<LookupAddress>;
function lookup(hostname: string, options: LookupOptions): Promise<LookupAddress | LookupAddress[]>;
function lookup(hostname: string): Promise<LookupAddress>;
async function lookup(hostname: string, options?: LookupOptions | number) {
  const addresses = await dns.lookup(hostname, { all: true });
  return typeof options === "object" && options.all
    ? addresses
    : expectDefined(addresses[0], "synthetic DNS address");
}

let restoreDns: () => void;
beforeAll(() => {
  const spy = vi.spyOn(dnsPromises, "lookup").mockImplementation(lookup);
  syncBuiltinESMExports();
  restoreDns = () => {
    spy.mockRestore();
    syncBuiltinESMExports();
  };
});
afterAll(() => restoreDns());

const cfg: OpenClawConfig = {
  tts: { provider: "google", providers: { google: { apiKey: "synthetic-voice-store-key" } } },
};
beforeEach(() => {
  // Load the real provider once for this connected authorization matrix.
  const registry = loadBundledCapabilityRuntimeRegistry({ pluginIds: ["google"], config: cfg });
  expect(registry.speechProviders.some((entry) => entry.provider.id === "google")).toBe(true);
  setActivePluginRegistry(registry);
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type RequestOptions = Parameters<typeof handleGatewayRequest>[0];

function operatorClient(scope: string): NonNullable<RequestOptions["client"]> {
  return {
    connId: "voice-store-boundary",
    connect: {
      role: "operator",
      scopes: [scope],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as NonNullable<RequestOptions["client"]>;
}

// Existing router tests replace handlers, and provider tests replace provider-http.
// This owns the missing composition: a lost caller must not reach Google's store:true POST.
it("fences design and replication writes at the real Google HTTP boundary", async () => {
  // Keep one provider instance: shared afterEach cleanup retires loaded plugins.
  for (const method of ["tts.designVoice", "tts.replicateVoice"] as const) {
    for (const scenario of ["write", "read", "revoked-during-dns"] as const) {
      dns.lookup.mockReset();
      dns.lookup.mockResolvedValue([{ address: "142.250.191.106", family: 4 }]);
      const client = operatorClient(scenario === "read" ? "operator.read" : "operator.write");
      const context = {
        getRuntimeConfig: () => cfg,
        logGateway: { warn: vi.fn() },
      } as unknown as RequestOptions["context"];
      const caller = captureGatewayDeviceRevocation(
        context,
        { deviceId: "voice-store-device", role: "operator" },
        () => !client.invalidated,
      );
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
          id: "voice_boundary",
          display_name: "Boundary voice",
          sample_audio: {
            data: Buffer.from("preview").toString("base64"),
            mime_type: "audio/wav",
          },
        }),
      );
      vi.stubGlobal("fetch", fetch);
      if (scenario === "revoked-during-dns") {
        dns.lookup.mockImplementation(async () => {
          // Revoke through the same owner used by device-token revocation, after
          // the real handler/provider entered guarded HTTP transport preparation.
          expect(caller.isCurrent()).toBe(true);
          await Promise.resolve();
          invalidateGatewayDeviceRevocation(context, "voice-store-device", "operator");
          expect(caller.isCurrent()).toBe(false);
          return [{ address: "142.250.191.106", family: 4 }];
        });
      }
      const respond = vi.fn();
      try {
        await handleGatewayRequest({
          req: {
            type: "req",
            id: `${method}-${scenario}`,
            method,
            params: {
              provider: "google",
              displayName: "Boundary voice",
              ...(method === "tts.designVoice"
                ? { prompt: "A calm, clear narrator." }
                : {
                    sourceAudioBase64: Buffer.from("source").toString("base64"),
                    consentAudioBase64: Buffer.from("consent").toString("base64"),
                  }),
            },
          },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: caller.isCurrent,
        });
        if (scenario === "write") {
          expect(fetch).toHaveBeenCalledTimes(1);
          const [url, init] = expectDefined(fetch.mock.calls[0], "Google CreateVoice request");
          expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/voices");
          expect(init?.method).toBe("POST");
          if (typeof init?.body !== "string") {
            throw new Error("Google CreateVoice must send a JSON string body");
          }
          expect(JSON.parse(init.body)).toMatchObject({
            store: true,
            voice: {
              type: method === "tts.designVoice" ? "prompted" : "replicated",
              display_name: "Boundary voice",
            },
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              provider: "google",
              outcome: "stored",
              id: "voice_boundary",
              name: "Boundary voice",
            }),
          );
          const schema =
            method === "tts.designVoice"
              ? TtsDesignVoiceResultSchema
              : TtsReplicateVoiceResultSchema;
          expect(Compile(schema).Check(respond.mock.calls[0]?.[1])).toBe(true);
        } else {
          expect(fetch).not.toHaveBeenCalled();
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: scenario === "read" ? "FORBIDDEN" : "UNAVAILABLE",
              message:
                scenario === "read"
                  ? "missing scope: operator.write"
                  : "Error: Gateway requester authority changed",
            }),
          );
        }
        if (scenario === "read") {
          expect(dns.lookup).not.toHaveBeenCalled();
        } else {
          expect(dns.lookup).toHaveBeenCalledExactlyOnceWith("generativelanguage.googleapis.com", {
            all: true,
          });
        }
        expect(respond).toHaveBeenCalledTimes(1);
      } finally {
        caller.release();
        closeGatewayDeviceRevocation(context);
      }
    }
  }
});
