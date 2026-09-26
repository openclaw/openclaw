import { spawn } from "node:child_process";
import { mkdir, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultAiTransportHost, type Context } from "@openclaw/ai";
import { registerSessionResourceCleanup } from "@openclaw/ai/internal/runtime";
import { build } from "esbuild";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sealSecretSentinel } from "../secrets/sentinel.js";
import { NativeRuntimeConfigSchema, type NativeRuntimeConfig } from "./native-runtime-config.js";
import {
  createNativeRuntime,
  type NativeRuntime,
  type NativeRuntimeResolved,
} from "./native-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtimes: NativeRuntime[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.close();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const binding = {
  gatewayId: "gateway",
  workspaceId: "workspace",
  sessionId: "session",
  runId: "run",
  attemptId: "attempt",
  epoch: "epoch",
  connectionId: "connection",
};
const selection = { provider: "openai", modelId: "local-model" };
const turn = { binding, selection };
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function configFor(workspace: string, baseUrl = "http://127.0.0.1:1/v1"): NativeRuntimeConfig {
  return {
    models: [
      {
        provider: "openai",
        id: "local-model",
        api: "openai-completions",
        baseUrl,
        contextWindow: 8192,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        apiKeyEnv: "NATIVE_TEST_KEY",
        headers: { "x-startup": "startup" },
      },
    ],
    workspaces: [{ id: "workspace", path: workspace, models: ["openai/local-model"] }],
  };
}
async function start(
  config: NativeRuntimeConfig,
  env: NodeJS.ProcessEnv = { NATIVE_TEST_KEY: "fixture-key" },
) {
  const runtime = await createNativeRuntime(config, env);
  runtimes.push(runtime);
  return runtime;
}
async function providerServer() {
  const requests: { headers: IncomingHttpHeaders; body: Record<string, unknown>; url?: string }[] =
    [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      requests.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
        url: request.url,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = {
        id: "fixture-completion",
        object: "chat.completion.chunk",
        created: 1,
        model: "local-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "native response" },
            finish_reason: null,
          },
        ],
      };
      response.write("data: " + JSON.stringify(chunk) + "\n\n");
      response.end(
        "data: " +
          JSON.stringify({
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected local provider port");
  }
  return { requests, baseUrl: "http://127.0.0.1:" + address.port + "/v1" };
}
const bundles = useAutoCleanupTempDirTracker(afterAll);
let probeEntry: string;
beforeAll(async () => {
  probeEntry = path.join(bundles.make("native-owner-probe-"), "probe.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./native-runtime.test-support.ts", import.meta.url))],
    outfile: probeEntry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire as createNativeProbeRequire } from "node:module"; const require = createNativeProbeRequire(import.meta.url);',
    },
  });
});
async function probe(scenario: string, config: NativeRuntimeConfig, env: NodeJS.ProcessEnv) {
  const root = tempDirs.make("native-probe-startup-");
  const file = path.join(root, "runtime.json");
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [probeEntry, file, scenario], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let result: Record<string, unknown> | undefined;
    child.on("message", (message) => {
      result = message as Record<string, unknown>;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 && result) {
        resolve(result);
      } else {
        reject(new Error("Native owner probe failed: " + code));
      }
    });
  });
}

describe("native runtime startup authority", () => {
  it("guards explicit custom authentication headers without blocking ordinary metadata", async () => {
    const config = configFor(tempDirs.make("native-custom-header-"));
    config.models[0]!.headers = { "x-route": "assistant", "x-session": "synthetic-custom-auth" };
    config.models[0]!.sensitiveHeaderNames = ["X-Session"];
    const runtime = await start(config);
    await runtime.withTurn(turn, async (resolved) => {
      expect(() => resolved.assertProtocolSafe({ role: "assistant" })).not.toThrow();
      expect(() => resolved.assertProtocolSafe({ text: "synthetic-custom-auth" })).toThrow(
        "Native credential appeared",
      );
      expect(resolved.hasCredentialPrefix("synthetic-custom-")).toBe(true);
    });
  });
  it("rejects a missing explicitly classified authentication header", async () => {
    const config = configFor(tempDirs.make("native-missing-header-"));
    config.models[0]!.sensitiveHeaderNames = ["x-missing"];
    await expect(start(config)).rejects.toThrow("Sensitive native header name is not configured");
  });
  it("filters HTTP-normalized representations of startup credential values", async () => {
    const config = configFor(tempDirs.make("native-http-secret-"));
    config.models[0]!.headers = { "x-api-key": "  synthetic-header-secret  " };
    const runtime = await start(config, { NATIVE_TEST_KEY: "synthetic-http-secret  " });
    await runtime.withTurn(turn, async (resolved) => {
      const headers = new Headers({
        Authorization: "Bearer synthetic-http-secret  ",
        ...config.models[0]!.headers,
      });
      expect(headers.get("authorization")).toBe("Bearer synthetic-http-secret");
      expect(headers.get("x-api-key")).toBe("synthetic-header-secret");
      for (const secret of [
        headers.get("authorization")!.slice("Bearer ".length),
        headers.get("x-api-key")!,
      ]) {
        expect(() => resolved.assertProtocolSafe({ text: secret })).toThrow(
          "Native credential appeared",
        );
        expect(resolved.hasCredentialPrefix(secret.slice(0, -1))).toBe(true);
      }
    });
  });
  it("preserves and freezes explicit local pricing and thinking mappings", async () => {
    const config = configFor(tempDirs.make("native-model-metadata-"));
    const cost = { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 };
    const thinkingLevelMap = { xhigh: "xhigh", max: "max", low: null };
    const input = { ...config, models: [{ ...config.models[0]!, cost, thinkingLevelMap }] };
    const pending = start(input);
    cost.input = 999;
    thinkingLevelMap.xhigh = "high";
    const runtime = await pending;
    await runtime.withTurn(turn, async ({ model: selected }) => {
      expect(selected.cost).toEqual({ input: 2, output: 4, cacheRead: 1, cacheWrite: 3 });
      expect(selected.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max", low: null });
      expect(Object.isFrozen(selected.cost)).toBe(true);
      expect(Object.isFrozen(selected.thinkingLevelMap)).toBe(true);
    });
  });
  it("requires complete finite nonnegative local pricing and canonical map keys", () => {
    const config = configFor(tempDirs.make("native-invalid-metadata-"));
    const base = config.models[0]!;
    for (const cost of [
      undefined,
      {},
      { input: 1, output: 2, cacheRead: 3 },
      ...[-1, Number.NaN, Infinity, "1"].map((input) => ({
        input,
        output: 1,
        cacheRead: 1,
        cacheWrite: 1,
      })),
    ]) {
      expect(
        NativeRuntimeConfigSchema.safeParse({ ...config, models: [{ ...base, cost }] }).success,
      ).toBe(false);
    }
    expect(NativeRuntimeConfigSchema.safeParse(config).success).toBe(true);
    for (const thinkingLevelMap of [{ turbo: "max" }, { high: true }]) {
      expect(
        NativeRuntimeConfigSchema.safeParse({ ...config, models: [{ ...base, thinkingLevelMap }] })
          .success,
      ).toBe(false);
    }
  });
  it("settles only its own provider session resources on success and failure", async () => {
    const runtime = await start(configFor(tempDirs.make("native-resource-owner-")));
    const cleaned: Array<string | undefined> = [];
    const unregister = registerSessionResourceCleanup((id) => cleaned.push(id));
    try {
      await runtime.withTurn(turn, async () => {
        expect(cleaned).toHaveLength(0);
      });
      await expect(
        runtime.withTurn(turn, async () => {
          throw new Error("native failure");
        }),
      ).rejects.toThrow("native failure");
      expect(cleaned).toHaveLength(2);
      expect(new Set(cleaned).size).toBe(2);
      for (const id of cleaned) {
        expect(typeof id).toBe("string");
        expect(id).not.toBe(binding.sessionId);
      }
    } finally {
      unregister();
    }
  });
  it("preserves opaque proxy auth over real HTTP without caller or ambient overrides", async () => {
    const provider = await providerServer();
    const workspace = tempDirs.make("native-runtime-");
    const result = await probe("snapshot", configFor(workspace, provider.baseUrl), {
      NODE_NO_WARNINGS: "1",
      NATIVE_TEST_KEY: "synthetic-opaque/Case+lease=v1.%25",
    });
    expect(result).toMatchObject({
      stopReason: "stop",
      hookCalled: false,
      frozen: true,
      hasModelHeaders: false,
      workspacePath: await realpath(workspace),
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer synthetic-opaque/Case+lease=v1.%25",
        "x-startup": "startup",
      },
      body: { model: "local-model", temperature: 0.25 },
    });
    expect(provider.requests[0]!.headers["x-extra"]).toBeUndefined();
    expect(JSON.stringify(provider.requests)).not.toMatch(/ambient-|wire-|injected-model/);
  });

  it("keeps externally supplied local-marker bytes opaque beside the real Gateway host", async () => {
    await import("../llm/ai-transport-host.js");
    const gatewayHost = getDefaultAiTransportHost();
    const unknown = "oc-sent-v2." + "A".repeat(48) + ".end";
    const known = sealSecretSentinel("synthetic-local-provider-value", {
      label: "native-host-proof",
    });
    expect(gatewayHost.resolveSecretSentinel(known)).toBe("synthetic-local-provider-value");
    expect(() => gatewayHost.resolveSecretSentinel(unknown)).toThrow("not registered");
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init).headers);
      return new Response(
        "data: " +
          JSON.stringify({
            id: "opaque-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "local-model",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "native response" },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const workspace = tempDirs.make("native-opaque-host-");
    const values = [known, "prefix-" + unknown + "-suffix"];
    await Promise.all(
      values.map(async (value) => {
        const config = configFor(workspace, "https://proxy.example.test/v1");
        config.models[0]!.headers = { "x-custom-auth": value };
        config.models[0]!.sensitiveHeaderNames = ["x-custom-auth"];
        const runtime = await start(config, { NATIVE_TEST_KEY: value });
        await runtime.withTurn(turn, async (resolved) => {
          const stream = await resolved.streamFn(resolved.model, context);
          const response = await stream.result();
          expect(response.stopReason, response.errorMessage).toBe("stop");
          expect(() => resolved.assertProtocolSafe(value)).toThrow("Native credential appeared");
        });
      }),
    );
    expect(
      requests
        .map((headers) => headers.get("authorization"))
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(values.map((value) => "Bearer " + value).toSorted((a, b) => a.localeCompare(b)));
    expect(
      requests
        .map((headers) => headers.get("x-custom-auth"))
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(values.toSorted((a, b) => a.localeCompare(b)));
    expect(getDefaultAiTransportHost()).toBe(gatewayHost);
    expect(gatewayHost.resolveSecretSentinel(known)).toBe("synthetic-local-provider-value");
    expect(() => gatewayHost.resolveSecretSentinel(unknown)).toThrow("not registered");
  });

  it("reads only named env keys once and fails missing credentials before opening workspaces", async () => {
    const config = configFor("/nonexistent-native-test-workspace");
    const reads: PropertyKey[] = [];
    const env = new Proxy(
      {},
      {
        get: (_target, key) => {
          reads.push(key);
          return undefined;
        },
      },
    );
    await expect(createNativeRuntime(config, env)).rejects.toThrow("NATIVE_TEST_KEY");
    expect(reads).toEqual(["NATIVE_TEST_KEY"]);
    config.workspaces[0]!.path = tempDirs.make("native-runtime-");
    config.models.push({ ...config.models[0]!, id: "second-model" });
    reads.length = 0;
    await start(
      config,
      new Proxy(
        {},
        {
          get: (_target, key) => {
            reads.push(key);
            return "fixture-key";
          },
        },
      ),
    );
    expect(reads).toEqual(["NATIVE_TEST_KEY"]);
  });

  it("rejects extra wire-style startup fields and endpoint interpolation", () => {
    const config = configFor(".");
    expect(NativeRuntimeConfigSchema.safeParse({ ...config, gatewayConfig: {} }).success).toBe(
      false,
    );
    expect(
      NativeRuntimeConfigSchema.safeParse({
        ...config,
        models: [{ ...config.models[0], apiKey: "inline-key" }],
      }).success,
    ).toBe(false);
    for (const baseUrl of [
      "https://user:password@example.com",
      "https://example.com/{ENV}",
      "file:///tmp/model",
    ]) {
      expect(
        NativeRuntimeConfigSchema.safeParse({
          ...config,
          models: [{ ...config.models[0], baseUrl }],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects duplicate models/workspaces, unknown model grants, and unavailable or ambient APIs", async () => {
    const workspace = tempDirs.make("native-runtime-");
    const config = configFor(workspace);
    await expect(
      createNativeRuntime(
        { ...config, models: [...config.models, ...config.models] },
        { NATIVE_TEST_KEY: "test" },
      ),
    ).rejects.toThrow("Duplicate");
    await expect(
      createNativeRuntime(
        { ...config, workspaces: [...config.workspaces, ...config.workspaces] },
        { NATIVE_TEST_KEY: "test" },
      ),
    ).rejects.toThrow("Duplicate");
    await expect(
      createNativeRuntime(
        {
          ...config,
          workspaces: [{ id: "workspace", path: workspace, models: ["missing/model"] }],
        },
        { NATIVE_TEST_KEY: "test" },
      ),
    ).rejects.toThrow("Unknown");
    for (const api of ["unregistered-api", "azure-openai-responses"]) {
      await expect(
        createNativeRuntime(
          { ...config, models: [{ ...config.models[0]!, api }] },
          { NATIVE_TEST_KEY: "test" },
        ),
      ).rejects.toThrow(/Unsupported|ambient-configured/);
    }
    await expect(
      createNativeRuntime(
        { ...config, models: [{ ...config.models[0]!, api: "google-vertex" }] },
        { NATIVE_TEST_KEY: "gcp-vertex-credentials" },
      ),
    ).rejects.toThrow("ambient ADC");
  });

  it("rejects files and nonexistent workspace directories", async () => {
    const root = tempDirs.make("native-runtime-");
    const file = path.join(root, "file");
    await writeFile(file, "not a directory");
    await expect(start(configFor(file))).rejects.toThrow("must be a directory");
    await expect(start(configFor(path.join(root, "missing")))).rejects.toThrow();
  });

  it("enforces workspace grants and exact immutable local model identity", async () => {
    const workspace = tempDirs.make("native-runtime-");
    const config = configFor(workspace);
    config.models.push({ ...config.models[0]!, id: "other-model" });
    config.workspaces[0]!.models = ["openai/local-model"];
    const runtime = await start(config);
    const callback = vi.fn(async () => {});
    await expect(
      runtime.withTurn({ ...turn, binding: { ...binding, workspaceId: "unknown" } }, callback),
    ).rejects.toThrow("not allowed");
    await expect(
      runtime.withTurn({ ...turn, selection: { ...selection, modelId: "other-model" } }, callback),
    ).rejects.toThrow("not allowed");
    await expect(
      runtime.withTurn({ ...turn, selection: { ...selection, modelId: "unknown" } }, callback),
    ).rejects.toThrow("not allowed");
    expect(callback).not.toHaveBeenCalled();
    await runtime.withTurn(turn, async (resolved) => {
      await expect(resolved.streamFn({ ...resolved.model }, context)).rejects.toThrow(
        "exact selected local model",
      );
      expect(() => {
        resolved.model.baseUrl = "http://127.0.0.1:1/evil";
      }).toThrow();
      expect(() => {
        resolved.model.input.push("image");
      }).toThrow();
    });
    const deniedConfig = configFor(workspace);
    deniedConfig.workspaces[0]!.models = [];
    const denied = await start(deniedConfig);
    await expect(denied.withTurn(turn, callback)).rejects.toThrow("not allowed");
  });

  it("canonicalizes symlinks and rejects retargeting before and during turns", async () => {
    const root = tempDirs.make("native-runtime-");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const link = path.join(root, "link");
    await mkdir(first);
    await mkdir(second);
    await symlink(first, link, "dir");
    const runtime = await start(configFor(link));
    await runtime.withTurn(turn, async ({ workspacePath }) => {
      expect(workspacePath).toBe(await realpath(first));
    });
    await expect(
      runtime.withTurn(turn, async (resolved) => {
        await unlink(link);
        await symlink(second, link, "dir");
        await expect(resolved.streamFn(resolved.model, context)).rejects.toThrow(
          "workspace changed",
        );
      }),
    ).rejects.toThrow("workspace changed");
    await expect(runtime.withTurn(turn, async () => {})).rejects.toThrow("workspace changed");
  });

  it("rejects directory replacement even when its canonical pathname is unchanged", async () => {
    const root = tempDirs.make("native-runtime-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const runtime = await start(configFor(workspace));
    await rename(workspace, path.join(root, "previous"));
    await mkdir(workspace);
    await expect(runtime.withTurn(turn, async () => {})).rejects.toThrow("workspace changed");
  });

  it("isolates concurrent native credentials and registries without mutating cwd or context", async () => {
    const provider = await providerServer();
    const result = await probe(
      "isolation",
      configFor(tempDirs.make("native-isolation-"), provider.baseUrl),
      { NODE_NO_WARNINGS: "1", NATIVE_FIRST_KEY: "first-key", NATIVE_SECOND_KEY: "second-key" },
    );
    expect(result).toEqual({
      reasons: ["stop", "stop", "stop"],
      cwdUnchanged: true,
      contextUnchanged: true,
    });
    expect(
      provider.requests
        .map((request) => request.headers.authorization)
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["Bearer first-key", "Bearer second-key", "Bearer second-key"]);
  });

  it("rechecks close after asynchronous admission and honors cancellation before I/O", async () => {
    const runtime = await start(configFor(tempDirs.make("native-runtime-")));
    await runtime.withTurn(turn, async (resolved) => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled fixture"));
      await expect(
        resolved.streamFn(resolved.model, context, { signal: controller.signal }),
      ).rejects.toThrow("cancelled fixture");
    });
    const callback = vi.fn(async () => {});
    const pending = runtime.withTurn(turn, callback);
    runtime.close();
    await expect(pending).rejects.toThrow("runtime is closed");
    expect(callback).not.toHaveBeenCalled();
  });

  it("revokes escaped stream functions after completion, failure, and runtime close", async () => {
    const runtime = await start(configFor(tempDirs.make("native-runtime-")));
    const saved = await runtime.withTurn(turn, async (resolved) => resolved);
    await expect(saved.streamFn(saved.model, context)).rejects.toThrow("turn is closed");
    let failed: NativeRuntimeResolved | undefined;
    await expect(
      runtime.withTurn(turn, async (resolved) => {
        failed = resolved;
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    await expect(failed!.streamFn(failed!.model, context)).rejects.toThrow("turn is closed");
    await expect(
      runtime.withTurn(turn, async (resolved) => {
        runtime.close();
        await expect(resolved.streamFn(resolved.model, context)).rejects.toThrow(
          "runtime is closed",
        );
      }),
    ).rejects.toThrow("runtime is closed");
    await expect(runtime.withTurn(turn, async () => {})).rejects.toThrow("runtime is closed");
    runtime.close();
  });
});
