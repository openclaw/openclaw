import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import * as mediaStore from "../../media/store.js";
import type { UnifiedModelCatalogProviderContext } from "../../plugins/types.js";
import {
  musicWavFixture as wav,
  installClawRouterMusicHostFixture,
} from "./music-generate-clawrouter.test-support.js";

const CLIP = "google/lyria-3-clip-preview";
const PRO = "google/lyria-3-pro-preview";
const nativePath = (model = CLIP) =>
  `/v1/native/google-gemini/v1beta/models/${model.slice(7)}:generateContent`;
const manifestPath = "/v1/proxy/google-gemini/music_generate";
function catalog(routeKind: "native" | "manifest" = "native") {
  return {
    version: "clawrouter.client-catalog.v1",
    observedAt: new Date().toISOString(),
    scope: { authType: "proxy_key", credentialId: "synthetic-music-grant" },
    providers: [
      {
        id: "google-gemini",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/google-gemini",
        routes: [
          {
            endpoint: "music_generate",
            path: "/v1beta/models/${model}:generateContent",
            methods: ["POST"],
            requestFormat: "google.music_generate",
            responseFormat: "google.music",
          },
        ],
        models: [CLIP, PRO].map((id) => ({
          id,
          upstream: id.slice(7),
          capabilities: ["audio.generate"],
        })),
        offers: [CLIP, PRO].map((modelId) => ({
          endpoint: "music_generate",
          modelId,
          transport: "http",
          routeKind,
          route:
            routeKind === "native"
              ? "/v1/native/google-gemini/v1beta/models/${model}:generateContent"
              : manifestPath,
          eligible: true,
          affordability: "request-dependent",
        })),
      },
    ],
  };
}

function payload(bytes: Buffer, mimeType = "audio/mpeg") {
  return {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            { text: "Synthetic lyrics" },
            { inlineData: { mimeType, data: bytes.toString("base64") } },
          ],
        },
      },
    ],
    usageMetadata: { totalTokenCount: 16 },
  };
}

const f = installClawRouterMusicHostFixture({ model: CLIP, catalog, payload });

it.each(["native", "manifest"] as const)(
  "runs the actual music tool through %s with proxy-only credentials",
  async (routeKind) => {
    f.inventory = catalog(routeKind);
    const save = vi.spyOn(mediaStore, "saveMediaBuffer");
    await f.execute({ lyrics: "Synthetic lyrics", instrumental: true });
    expect(f.posts()).toHaveLength(1);
    expect(f.posts()[0]?.path).toBe(routeKind === "native" ? nativePath() : manifestPath);
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "A synthetic melody\n\nInstrumental only. No vocals, no sung lyrics, no spoken word.\n\nLyrics:\nSynthetic lyrics",
            },
          ],
        },
      ],
      generationConfig: { responseModalities: ["AUDIO", "TEXT"] },
    };
    expect(f.posts()[0]?.body).toEqual(
      routeKind === "manifest" ? { body, pathParams: { model: "lyria-3-clip-preview" } } : body,
    );
    for (const call of f.calls) {
      expect(call.headers.authorization).toBe("Bearer synthetic-router-key");
      expect(call.headers["x-goog-api-key"]).toBeUndefined();
      expect(call.headers["x-api-key"]).toBeUndefined();
    }
    expect(save.mock.f.calls[0]?.[0]).toEqual(f.mp3);
    expect(f.alternateCalls).toBe(0);
  },
);

it("returns Pro WAV bytes without promising or serializing an output format", async () => {
  const audio = wav();
  f.output = payload(audio, "audio/wav");
  const save = vi.spyOn(mediaStore, "saveMediaBuffer");
  await f.execute({ model: `clawrouter/${PRO}`, format: "wav" });
  expect(f.posts()[0]?.path).toBe(nativePath(PRO));
  expect(save.mock.f.calls[0]?.[0]).toEqual(audio);
  expect(JSON.stringify(f.posts()[0]?.body)).not.toContain("wav");
});

it("serializes an actual host-loaded reference image inline without a remote asset URL", async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=";
  const file = `${f.state.workspaceDir}/lyria-reference.png`;
  await fs.writeFile(file, Buffer.from(png, "base64"));
  await f.execute({ image: file });
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]?.body).toMatchObject({
    contents: [
      {
        parts: [
          { text: "A synthetic melody" },
          { inlineData: { mimeType: "image/png", data: png } },
        ],
      },
    ],
  });
});

it("publishes fresh entitled music offers through the registered catalog without pricing defaults", async () => {
  const selected = f.acquired.registry.modelCatalogProviders.find(
    (entry) =>
      entry.provider.provider === "clawrouter" && entry.provider.kinds.includes("music_generation"),
  )!.provider;
  const resolveAuth = () => ({
    apiKey: undefined,
    profileId: "clawrouter:music",
    mode: "api_key" as const,
    source: "env" as const,
  });
  const context: UnifiedModelCatalogProviderContext = {
    config: f.config,
    env: {},
    includeLive: true,
    agentDir: f.state.agentDir(),
    resolveProviderApiKey: resolveAuth,
    resolveProviderAuth: resolveAuth,
  };
  const rows = await selected.liveCatalog!(context);
  expect(rows?.map((row) => [row.kind, row.model, row.default])).toEqual([
    ["music_generation", CLIP, undefined],
    ["music_generation", PRO, undefined],
  ]);
  f.inventory.providers[0]!.offers = [];
  await expect(selected.liveCatalog!(context)).resolves.toEqual([]);
  f.inventory = catalog();
  f.inventory.scope.authType = "admin";
  await expect(selected.liveCatalog!(context)).rejects.toThrow("scope");
  expect(f.posts()).toHaveLength(0);
});

it("does not repeat generation when local asset persistence fails after EOF", async () => {
  vi.spyOn(mediaStore, "saveMediaBuffer").mockRejectedValueOnce(
    new Error("synthetic disk failure"),
  );
  await expect(f.execute()).rejects.toThrow("synthetic disk failure");
  expect(f.posts()).toHaveLength(1);
  expect(f.completed).toBe(1);
  expect(f.alternateCalls).toBe(0);
});

it("keeps the configured alternate usable when no paid POST was attempted", async () => {
  f.inventory.providers[0]!.offers = [];
  await f.execute();
  expect(f.posts()).toHaveLength(0);
  expect(f.alternateCalls).toBe(1);
});

it.each([
  "text-only",
  "malformed JSON",
  "ambiguous",
  "bad base64",
  "HTTP error",
  "transport uncertainty",
])("never buys another provider attempt after %s", async (failure) => {
  if (failure === "text-only") {
    f.output = {
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "lyrics only" }] } }],
    };
  }
  if (failure === "malformed JSON") {
    f.output = '{"candidates":';
  }
  if (failure === "ambiguous") {
    f.output = { candidates: [...payload(f.mp3).candidates, ...payload(f.mp3).candidates] };
  }
  if (failure === "bad base64") {
    f.output = {
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ inlineData: { data: "ZE==", mimeType: "audio/mpeg" } }] },
        },
      ],
    };
  }
  if (failure === "HTTP error") {
    f.status = 502;
  }
  if (failure === "transport uncertainty") {
    f.hold = "disconnect";
  }
  await expect(f.execute()).rejects.toThrow();
  expect(f.posts()).toHaveLength(1);
  expect(f.alternateCalls).toBe(0);
});

it.each(["before", "headers", "body", "after EOF"] as const)(
  "stops the real caller signal at %s without replay",
  async (phase) => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled music");
    if (phase === "before") {
      controller.abort(reason);
    }
    if (phase === "headers" || phase === "body") {
      f.hold = phase;
    }
    if (phase === "after EOF") {
      const save = mediaStore.saveMediaBuffer;
      vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async (...args) => {
        const result = await save(...args);
        controller.abort(reason);
        return result;
      });
    }
    const outcome = f.execute({}, controller.signal);
    const rejected = expect(outcome).rejects.toThrow();
    if (phase === "headers" || phase === "body") {
      await Promise.race([
        f.held.promise,
        outcome.then(() => {
          throw new Error("Settled before the held response");
        }),
      ]);
      controller.abort(reason);
    }
    await rejected;
    expect(f.posts()).toHaveLength(phase === "before" ? 0 : 1);
    expect(f.alternateCalls).toBe(0);
    if (phase === "after EOF") {
      expect(f.completed).toBe(1); // No compensating upstream request/refund claim.
    }
  },
);

it.each([
  "stale",
  "foreign scope",
  "wrong upstream",
  "wrong format",
  "mixed capability",
  "wrong path",
])("denies a %s offer before music POST", async (failure) => {
  if (failure === "stale") {
    f.inventory.observedAt = new Date(Date.now() - 61_000).toISOString();
  }
  if (failure === "foreign scope") {
    f.inventory.scope.authType = "admin";
  }
  if (failure === "wrong upstream") {
    f.inventory.providers[0]!.models[0]!.upstream = "lyria-3-pro-preview";
  }
  if (failure === "wrong format") {
    f.inventory.providers[0]!.routes[0]!.requestFormat = "google.generate_content";
  }
  if (failure === "mixed capability") {
    f.inventory.providers[0]!.models[0]!.capabilities.push("llm.generate");
  }
  if (failure === "wrong path") {
    f.inventory.providers[0]!.routes[0]!.path = "/v1beta/models/${model}:streamGenerateContent";
  }
  await expect(f.execute({ model: `clawrouter/${CLIP}` })).rejects.toThrow();
  expect(f.posts()).toHaveLength(0);
});
