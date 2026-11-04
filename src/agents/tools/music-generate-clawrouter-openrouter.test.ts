import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import * as mediaStore from "../../media/store.js";
import type { UnifiedModelCatalogProviderContext } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  installClawRouterMusicHostFixture,
  musicWavFixture,
} from "./music-generate-clawrouter.test-support.js";

const PRO = "openrouter/google/lyria-3-pro-preview";
const CLIP = "openrouter/google/lyria-3-clip-preview";
const NATIVE = "/v1/native/openrouter/v1/chat/completions";
const MANIFEST = "/v1/proxy/openrouter/music_generate";
function catalog(routeKind: "native" | "manifest" = "native") {
  return {
    version: "clawrouter.client-catalog.v1",
    observedAt: new Date().toISOString(),
    scope: { authType: "proxy_key", credentialId: "synthetic-music-grant" },
    providers: [
      {
        id: "openrouter",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/openrouter",
        routes: [
          {
            endpoint: "music_generate",
            path: "/v1/chat/completions",
            methods: ["POST"],
            requestFormat: "openai.chat_completions",
            responseFormat: "openai.chat_completions",
          },
        ],
        models: [PRO, CLIP].map((id) => ({
          id,
          upstream: id.slice("openrouter/".length),
          capabilities: ["music.generate"],
        })),
        offers: [PRO, CLIP].map((modelId) => ({
          endpoint: "music_generate",
          modelId,
          transport: "http",
          routeKind,
          route: routeKind === "native" ? NATIVE : MANIFEST,
          eligible: true,
          affordability: "request-dependent",
        })),
      },
    ],
  };
}
function event(audio: { data?: string; transcript?: string }) {
  return `data: ${JSON.stringify({ model: "observed-not-selected", choices: [{ delta: { audio } }] })}\n\n`;
}
function stream(bytes: Buffer) {
  const encoded = bytes.toString("base64");
  return [
    event({ data: encoded.slice(0, 5), transcript: "café " }),
    event({ data: encoded.slice(5), transcript: "synthetic track" }),
    "data: [DONE]\n\n",
  ];
}
const f = installClawRouterMusicHostFixture({
  model: PRO,
  catalog,
  payload: () => stream(musicWavFixture()),
  contentType: "text/event-stream",
  bodyPrefix: ": waiting\n\n",
});
const profiles = [PRO, CLIP].flatMap((model) =>
  (["native", "manifest"] as const).flatMap((routeKind) =>
    ([undefined, "mp3"] as const).map((format) => ({ model, routeKind, format })),
  ),
);

it.each(profiles)(
  "runs registered music $model/$routeKind/$format with full output",
  async ({ model, routeKind, format }) => {
    f.inventory = catalog(routeKind);
    const audio = format === "mp3" ? f.mp3 : musicWavFixture();
    f.output = stream(audio);
    const save = vi.spyOn(mediaStore, "saveMediaBuffer");
    const result = await f.execute({
      model: `clawrouter/${model}`,
      format,
      lyrics: "Synthetic lyrics",
      instrumental: true,
      durationSeconds: 180,
    });
    expect(f.posts()).toHaveLength(1);
    const post = f.posts()[0]!;
    expect(post.path).toBe(routeKind === "native" ? NATIVE : MANIFEST);
    expect(post.headers.accept).toBe("text/event-stream");
    for (const call of f.calls) {
      expect(call.headers.authorization).toBe("Bearer synthetic-router-key");
      expect(call.headers["x-goog-api-key"]).toBeUndefined();
      expect(call.headers["x-api-key"]).toBeUndefined();
      expect(call.headers["api-key"]).toBeUndefined();
      expect(call.headers.cookie).toBeUndefined();
    }
    const body = {
      model: model.slice("openrouter/".length),
      messages: [
        {
          role: "user",
          content:
            "A synthetic melody\n\nInstrumental only. No vocals, no sung lyrics, no spoken word.\n\nLyrics:\nSynthetic lyrics\n\nTarget duration: about 180 seconds.",
        },
      ],
      modalities: ["text", "audio"],
      audio: { format: format ?? "wav" },
      stream: true,
    };
    expect(post.body).toEqual(routeKind === "manifest" ? { body } : body);
    expect(save.mock.calls[0]?.[0]).toEqual(audio);
    expect(result.details).toMatchObject({ provider: "clawrouter", model });
    expect(f.alternateCalls).toBe(0);
  },
);

it.each([PRO, CLIP])("rejects every reference before loading for %s", async (model) => {
  const base = f.config.models!.providers!.clawrouter!.baseUrl;
  await expect(
    f.execute({ model: `clawrouter/${model}`, image: `${base}/reference.png` }),
  ).rejects.toThrow(/reference image/);
  expect(f.calls).toHaveLength(0);
  expect(f.alternateCalls).toBe(0);
});

it.each([
  "stale",
  "foreign scope",
  "wrong upstream",
  "wrong format",
  "wrong path",
  "chat capability",
  "foreign origin",
])("denies %s before music dispatch", async (failure) => {
  if (failure === "stale") {
    f.inventory.observedAt = "2000-01-01T00:00:00Z";
  }
  if (failure === "foreign scope") {
    f.inventory.scope.authType = "admin";
  }
  if (failure === "wrong upstream") {
    f.inventory.providers[0]!.models[0]!.upstream = "google/other";
  }
  if (failure === "wrong format") {
    f.inventory.providers[0]!.routes[0]!.responseFormat = "google.music";
  }
  if (failure === "wrong path") {
    f.inventory.providers[0]!.routes[0]!.path = "/chat/completions";
  }
  if (failure === "chat capability") {
    f.inventory.providers[0]!.models[0]!.capabilities = ["llm.chat"];
  }
  if (failure === "foreign origin") {
    f.inventory.providers[0]!.offers[0]!.route = "https://foreign.example/music";
  }
  await expect(f.execute({ model: `clawrouter/${PRO}` })).rejects.toThrow();
  expect(f.posts()).toHaveLength(0);
});

it("retains an actual configured alternate before any paid attempt", async () => {
  f.inventory.providers[0]!.offers = [];
  await f.execute();
  expect(f.posts()).toHaveLength(0);
  expect(f.alternateCalls).toBe(1);
});

it.each([
  "text only",
  "missing DONE",
  "malformed JSON",
  "invalid UTF8",
  "bad base64",
  "ambiguous choices",
  "partial finish",
  "error event",
  "data after DONE",
  "pricing denial",
  "redirect",
  "lost response",
  "wire overflow",
  "audio overflow",
  "text overflow",
])("never pays an alternate after %s", async (failure) => {
  if (failure === "text only") {
    f.output = [event({ transcript: "only text" }), "data: [DONE]\n"];
  }
  if (failure === "missing DONE") {
    f.output = [event({ data: f.mp3.toString("base64") })];
  }
  if (failure === "malformed JSON") {
    f.output = "data: {invalid\n\n";
  }
  if (failure === "invalid UTF8") {
    f.output = [Buffer.from([0xff]), "\ndata: [DONE]\n"];
  }
  if (failure === "bad base64") {
    f.output = [event({ data: "ZE==" }), "data: [DONE]\n"];
  }
  if (failure === "ambiguous choices") {
    f.output = 'data: {"choices":[{},{}]}\n\ndata: [DONE]\n';
  }
  if (failure === "partial finish") {
    f.output = 'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n';
  }
  if (failure === "error event") {
    f.output = 'data: {"error":{"message":"synthetic provider failure"}}\n\n';
  }
  if (failure === "data after DONE") {
    f.output = [...stream(musicWavFixture()), event({ transcript: "late" })];
  }
  if (failure === "pricing denial") {
    f.status = 402;
  }
  if (failure === "redirect") {
    f.status = 307;
  }
  if (failure === "lost response") {
    f.hold = "disconnect";
  }
  if (failure === "wire overflow") {
    f.output = [`:${"x".repeat(65534)}\n`.repeat(513), ...stream(musicWavFixture())];
  }
  if (failure === "audio overflow") {
    f.output = stream(Buffer.alloc(16 * 1024 * 1024 + 1));
  }
  if (failure === "text overflow") {
    f.output = [event({ transcript: "x".repeat(1024 * 1024 + 1) }), "data: [DONE]\n"];
  }
  const save = vi.spyOn(mediaStore, "saveMediaBuffer");
  await expect(f.execute()).rejects.toThrow();
  expect(f.posts()).toHaveLength(1);
  expect(f.alternateCalls).toBe(0);
  expect(save).not.toHaveBeenCalled();
});

it.each(["before", "catalog", "headers", "body", "DONE before EOF", "after EOF"] as const)(
  "threads actual caller cancellation at %s",
  async (phase) => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled music");
    if (phase === "before") {
      controller.abort(reason);
    }
    if (
      phase === "catalog" ||
      phase === "headers" ||
      phase === "body" ||
      phase === "DONE before EOF"
    ) {
      f.hold = phase === "DONE before EOF" ? "body" : phase;
      if (phase === "DONE before EOF") {
        f.bodyPrefix = stream(musicWavFixture()).join("");
      }
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
    if (
      phase === "catalog" ||
      phase === "headers" ||
      phase === "body" ||
      phase === "DONE before EOF"
    ) {
      await Promise.race([
        f.held.promise,
        outcome.then(() => {
          throw new Error("settled before held response");
        }),
      ]);
      controller.abort(reason);
    }
    await rejected;
    if (
      phase === "catalog" ||
      phase === "headers" ||
      phase === "body" ||
      phase === "DONE before EOF"
    ) {
      await vi.waitFor(() => expect(f.heldClosed).toBe(true));
    }
    expect(f.posts()).toHaveLength(phase === "before" || phase === "catalog" ? 0 : 1);
    expect(f.alternateCalls).toBe(0);
    if (phase === "after EOF") {
      expect(f.completed).toBe(1);
    }
  },
);

it("does not repeat a completed paid request after local persistence fails", async () => {
  vi.spyOn(mediaStore, "saveMediaBuffer").mockRejectedValueOnce(
    new Error("synthetic disk failure"),
  );
  await expect(f.execute()).rejects.toThrow("synthetic disk failure");
  expect(f.posts()).toHaveLength(1);
  expect(f.completed).toBe(1);
  expect(f.alternateCalls).toBe(0);
});

it("publishes only fresh text-only entitled offers with unknown prices", async () => {
  const selected = f.acquired.registry.modelCatalogProviders.find(
    (entry) =>
      entry.provider.provider === "clawrouter" && entry.provider.kinds.includes("music_generation"),
  )!.provider;
  const auth = () => ({
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
    resolveProviderApiKey: auth,
    resolveProviderAuth: auth,
  };
  const rows = await selected.liveCatalog!(context);
  expect(rows?.map((row) => ({ model: row.model, modes: row.modes }))).toEqual([
    { model: PRO, modes: ["generate"] },
    { model: CLIP, modes: ["generate"] },
  ]);
  for (const row of rows ?? []) {
    expect(row).not.toHaveProperty("cost");
    expect(row).not.toHaveProperty("pricing");
  }
  f.inventory.providers[0]!.offers = [];
  await expect(selected.liveCatalog!(context)).resolves.toEqual([]);
  expect(f.posts()).toHaveLength(0);
});

it("rejects oversized prompts before discovery or POST", async () => {
  await expect(
    f.execute({ model: `clawrouter/${PRO}`, prompt: "x".repeat(32769) }),
  ).rejects.toThrow(/bounded/);
  expect(f.calls).toHaveLength(0);
});

it("keeps registered provider discovery, POST and EOF under one deadline", async () => {
  f.hold = "body";
  const provider = f.acquired.registry.musicGenerationProviders.find(
    (entry) => entry.provider.id === "clawrouter",
  )!.provider;
  const origin = f.config.models?.providers?.clawrouter?.baseUrl;
  if (!origin) {
    throw new Error("Music fixture origin missing");
  }
  const target = new URL(NATIVE, origin).href;
  const undici: typeof import("undici") = createRequire(import.meta.url)("undici/index.js");
  const key = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  const firstRead = createDeferredCore();
  const restores: Array<() => void> = [];
  const parents = new WeakMap<AbortSignal, AbortSignal>();
  let timer: { signal: AbortSignal; deadline: number; handle: NodeJS.Timeout } | undefined;
  let timerCount = 0;
  let timerCleared = false;
  let postSignal: AbortSignal | null | undefined;
  let posts = 0;
  let readers = 0;
  let reads = 0;
  let observed = false;
  let held = false;
  void f.held.promise.then(() => {
    held = true;
  });
  const describe = (value: unknown) => {
    const chain: Array<{ name: string; code: string }> = [];
    let current = value;
    for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
      const name = "name" in current ? current.name : undefined;
      const code = "code" in current ? current.code : undefined;
      chain.push({
        name:
          typeof name === "string" &&
          [
            "Error",
            "TypeError",
            "TimeoutError",
            "AbortError",
            "DOMException",
            "BodyTimeoutError",
            "HeadersTimeoutError",
            "SocketError",
          ].includes(name)
            ? name
            : "other",
        code:
          typeof code === "string" &&
          [
            "UND_ERR_BODY_TIMEOUT",
            "UND_ERR_HEADERS_TIMEOUT",
            "UND_ERR_SOCKET",
            "UND_ERR_ABORT",
            "UND_ERR_ABORTED",
            "UND_ERR_DESTROYED",
            "UND_ERR_CLOSED",
            "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
            "ABORT_ERR",
            "ECONNRESET",
            "ETIMEDOUT",
            "ERR_STREAM_PREMATURE_CLOSE",
          ].includes(code)
            ? code
            : "other",
      });
      current = "cause" in current ? current.cause : undefined;
    }
    return chain;
  };
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeAny = AbortSignal.any;
  const timerSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) => {
      const handle = nativeSetTimeout(callback, delay, ...args);
      if (args[3] === "clawrouter.music") {
        timerCount++;
        const [controller, duration, start, , , signal] = args;
        if (
          controller instanceof AbortController &&
          typeof duration === "number" &&
          Number.isFinite(duration) &&
          typeof start === "number" &&
          Number.isFinite(start) &&
          signal instanceof AbortSignal
        ) {
          timer = { signal, deadline: start + duration, handle };
        }
      }
      return handle;
    });
  const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    if (timer && handle === timer.handle) {
      timerCleared = true;
    }
    return nativeClearTimeout(handle);
  });
  const anySpy = vi.spyOn(AbortSignal, "any").mockImplementation((signals) => {
    const combined = nativeAny.call(AbortSignal, signals);
    if (timer && Array.isArray(signals) && signals.includes(timer.signal)) {
      parents.set(combined, timer.signal);
    }
    return combined;
  });
  const fetch: typeof undici.fetch = (input, init) => {
    const response = undici.fetch(input, init);
    if (input === target && init?.method === "POST") {
      posts++;
      postSignal = init.signal;
      void response
        .then((result) => {
          const body = result.body;
          if (!body) {
            return;
          }
          const getReader = body.getReader.bind(body);
          const readerSpy = vi.spyOn(body, "getReader").mockImplementation((...args) => {
            const reader = getReader(...args);
            readers++;
            const read = reader.read.bind(reader);
            const readSpy = vi.spyOn(reader, "read").mockImplementation((...readArgs) => {
              reads++;
              firstRead.resolve();
              const pending: ReturnType<typeof read> = Reflect.apply(read, reader, readArgs);
              void pending.catch((error: unknown) => {
                if (!observed) {
                  observed = true;
                  console.error(
                    "[clawrouter-music-bound-first-read]",
                    JSON.stringify({
                      error: describe(error),
                      retainedSignal: {
                        aborted: timer?.signal.aborted,
                        reason: describe(timer?.signal.reason),
                      },
                      postSignal: {
                        aborted: postSignal?.aborted,
                        reason: describe(postSignal?.reason),
                      },
                      retainedTimerRemainingMs: timer
                        ? timer.deadline - performance.now()
                        : undefined,
                      beforeRetainedTimerCleanup: !timerCleared,
                      originalAbsoluteDeadlineObserved: false,
                    }),
                  );
                }
              });
              return pending;
            });
            restores.push(() => readSpy.mockRestore());
            return reader;
          });
          restores.push(() => readerSpy.mockRestore());
        })
        .catch(() => undefined);
    }
    return response;
  };
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: { ...undici, fetch },
  });
  let settled: Promise<unknown> | undefined;
  try {
    const request = provider.generateMusic({
      provider: "clawrouter",
      model: PRO,
      prompt: "A synthetic melody",
      cfg: f.config,
      agentDir: f.state.agentDir(),
      timeoutMs: 1000,
    });
    settled = request.then(
      () => undefined,
      () => undefined,
    );
    await Promise.race([firstRead.promise, settled]);
    expect(posts).toBe(1);
    expect(timerCount).toBe(1);
    expect(readers).toBe(1);
    expect(reads).toBeGreaterThan(0);
    expect(held).toBe(true);
    expect(timerCleared).toBe(false);
    if (!timer || !postSignal) {
      throw new Error("Music fixture did not bind the retained timer and POST signal");
    }
    // The guard composes the retained signal with its per-request cancellation owner.
    expect(parents.get(postSignal)).toBe(timer.signal);
    console.error(
      "[clawrouter-music-bound-reader]",
      JSON.stringify({ posts, timerCount, readers, reads, held, signalLineage: true }),
    );
    await expect(request).rejects.toThrow(/timed out/);
    expect(f.posts()).toHaveLength(1);
    await vi.waitFor(() => expect(f.heldClosed).toBe(true));
    expect(f.alternateCalls).toBe(0);
  } finally {
    await settled;
    for (const restore of restores.reverse()) {
      restore();
    }
    anySpy.mockRestore();
    clearSpy.mockRestore();
    timerSpy.mockRestore();
    if (previous) {
      Object.defineProperty(globalThis, key, previous);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
