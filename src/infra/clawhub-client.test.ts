// Verifies ClawHub client authentication, URL, retry, timeout, and body bounds.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { fetchClawHubJson } from "./clawhub-client.js";
import { fetchClawHubSkillVerification, searchClawHubSkills } from "./clawhub-skills.js";

function createStalledBodyResponse(params: {
  headers: HeadersInit;
  firstChunk: Uint8Array;
  status?: number;
  statusText?: string;
}): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(params.firstChunk);
    },
    cancel(reason) {
      cancel(reason);
    },
  });
  return {
    response: new Response(body, {
      status: params.status ?? 200,
      statusText: params.statusText,
      headers: params.headers,
    }),
    cancel,
  };
}

function malformedUtf8(prefix: string, suffix: string): ArrayBuffer {
  const prefixBytes = new TextEncoder().encode(prefix);
  const suffixBytes = new TextEncoder().encode(suffix);
  const buffer = new ArrayBuffer(prefixBytes.byteLength + 1 + suffixBytes.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(prefixBytes);
  bytes[prefixBytes.byteLength] = 0xff;
  bytes.set(suffixBytes, prefixBytes.byteLength + 1);
  return buffer;
}

async function writeConfigFile(configPath: string, contents: string) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, contents, "utf8");
}

async function withWindowsAppData(run: (root: string) => Promise<void>) {
  await withTestDir({ prefix: "openclaw-clawhub-appdata-" }, async (appDataRoot) => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    setTestEnvValue("APPDATA", appDataRoot);
    deleteTestEnvValue("XDG_CONFIG_HOME");
    try {
      await run(appDataRoot);
    } finally {
      platformSpy.mockRestore();
    }
  });
}

describe("clawhub client", () => {
  const originalEnv = captureEnv(["APPDATA", "HOME", "XDG_CONFIG_HOME"]);

  async function searchAuthorizationHeader(): Promise<string | null> {
    let authorization: string | null = null;
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async (_input, init) => {
          authorization = new Headers(init?.headers).get("Authorization");
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toStrictEqual([]);
    return authorization;
  }

  async function expectSearchUsesAuthToken(expectedToken: string): Promise<void> {
    await expect(searchAuthorizationHeader()).resolves.toBe(`Bearer ${expectedToken}`);
  }

  afterEach(() => {
    delete process.env.OPENCLAW_CLAWHUB_URL;
    delete process.env.CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_AUTH_TOKEN;
    delete process.env.CLAWHUB_CONFIG_PATH;
    delete process.env.CLAWDHUB_CONFIG_PATH;
    delete process.env.CLAWHUB_DISABLE_TELEMETRY;
    delete process.env.CLAWDHUB_DISABLE_TELEMETRY;
    originalEnv.restore();
  });

  it.each([
    ["without a token", JSON.stringify({})],
    ["with malformed JSON", "{"],
  ])(
    "does not fall back to a legacy token when the canonical config exists %s",
    async (_, contents) => {
      await withWindowsAppData(async (appDataRoot) => {
        await Promise.all([
          writeConfigFile(path.join(appDataRoot, "clawhub", "config.json"), contents),
          writeConfigFile(
            path.join(appDataRoot, "clawdhub", "config.json"),
            JSON.stringify({ token: "stale-legacy-token" }),
          ),
        ]);
        await expect(searchAuthorizationHeader()).resolves.toBeNull();
      });
    },
  );

  it.runIf(process.platform === "darwin")(
    "loads ClawHub request auth from the macOS Application Support path",
    async () => {
      await withTestDir({ prefix: "openclaw-clawhub-home-" }, async (fakeHome) => {
        const configPath = path.join(
          fakeHome,
          "Library",
          "Application Support",
          "clawhub",
          "config.json",
        );
        const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
        try {
          await writeConfigFile(configPath, JSON.stringify({ token: "fixture-macos-token" }));

          await expectSearchUsesAuthToken("fixture-macos-token");
        } finally {
          homedirSpy.mockRestore();
        }
      });
    },
  );

  it.runIf(process.platform === "darwin")(
    "falls back to XDG_CONFIG_HOME for ClawHub request auth on macOS",
    async () => {
      await withTestDir({ prefix: "openclaw-clawhub-home-" }, async (fakeHome) => {
        await withTestDir({ prefix: "openclaw-clawhub-xdg-" }, async (xdgRoot) => {
          const configPath = path.join(xdgRoot, "clawhub", "config.json");
          const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
          setTestEnvValue("XDG_CONFIG_HOME", xdgRoot);
          try {
            await writeConfigFile(configPath, JSON.stringify({ token: "fixture-xdg-token" }));

            await expectSearchUsesAuthToken("fixture-xdg-token");
          } finally {
            homedirSpy.mockRestore();
          }
        });
      });
    },
  );

  it("uses a valid Retry-After hint when RateLimit-Reset is malformed", async () => {
    process.env.CLAWHUB_CONFIG_PATH = path.join(os.tmpdir(), "openclaw-no-clawhub-config");
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response("Rate limit exceeded", {
            status: 429,
            headers: {
              "RateLimit-Reset": "invalid",
              "Retry-After": "7",
            },
          }),
      }),
    ).rejects.toThrow(/Rate limit exceeded \(resets in 7s\) Sign in for higher rate limits\.$/);
  });

  it("preserves the final ClawHub error body after transient retries are exhausted", async () => {
    let attempts = 0;
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () => {
          attempts += 1;
          return new Response("Rate limit temporarily unavailable", {
            status: 503,
            headers: { "Retry-After": "0" },
          });
        },
      }),
    ).rejects.toThrow("ClawHub /api/v1/search failed (503): Rate limit temporarily unavailable");

    expect(attempts).toBe(4);
  });

  it.each(["GET", "POST"] as const)(
    "replays a pre-header timeout only for %s reads",
    async (method) => {
      let attempts = 0;
      const result = fetchClawHubJson({
        path: "/timeout",
        method,
        skipAuth: true,
        timeoutMs: 5,
        fetchImpl: async (_input, init) => {
          attempts += 1;
          if (attempts > 1) {
            return new Response('{"recovered":true}');
          }
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const reason: unknown = init.signal?.reason;
                reject(reason instanceof Error ? reason : new Error("Expected a timeout Error"));
              },
              { once: true },
            );
          });
        },
      });
      if (method === "GET") {
        await expect(result).resolves.toEqual({ recovered: true });
        expect(attempts).toBe(2);
      } else {
        await expect(result).rejects.toThrow("ClawHub request timed out after 5ms");
        expect(attempts).toBe(1);
      }
    },
  );

  it("rejects malformed UTF-8 in otherwise valid ClawHub JSON", async () => {
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response(malformedUtf8('{"results":[{"slug":"', '"}]}'), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("ClawHub /api/v1/search returned malformed JSON");
  });

  it("times out and cancels stalled successful ClawHub JSON bodies", async () => {
    const stalled = createStalledBodyResponse({
      firstChunk: new TextEncoder().encode('{"results":['),
      headers: { "content-type": "application/json" },
    });

    await expect(
      searchClawHubSkills({
        query: "calendar",
        timeoutMs: 5,
        fetchImpl: async () => stalled.response,
      }),
    ).rejects.toThrow(/ClawHub \/api\/v1\/search response stalled after 5ms/);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("times out and cancels stalled ClawHub error bodies", async () => {
    const stalledResponses: ReturnType<typeof createStalledBodyResponse>[] = [];

    await expect(
      searchClawHubSkills({
        query: "calendar",
        timeoutMs: 5,
        fetchImpl: async () => {
          const stalled = createStalledBodyResponse({
            firstChunk: new TextEncoder().encode("partial error"),
            headers: { "content-type": "text/plain", "retry-after": "0" },
            status: 500,
            statusText: "Server Error",
          });
          stalledResponses.push(stalled);
          return stalled.response;
        },
      }),
    ).rejects.toThrow("ClawHub /api/v1/search failed (500): Server Error");
    for (const stalled of stalledResponses) {
      expect(stalled.cancel).toHaveBeenCalledTimes(1);
    }
    const finalResponse = stalledResponses.at(-1);
    expect(finalResponse?.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it.each([{ kind: "verification", maxMiB: 64, requestPath: "/api/v1/skills/weather/verify" }])(
    "bounds oversized $kind JSON and cancels the stream",
    async ({ kind, maxMiB, requestPath }) => {
      const cancel = vi.fn();
      const chunk = new Uint8Array(512 * 1024).fill("x".charCodeAt(0));
      let emitted = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted >= (maxMiB + 1) * 2) {
            controller.close();
            return;
          }
          emitted += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancel();
        },
      });
      const fetchImpl = async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      const result =
        kind === "verification"
          ? fetchClawHubSkillVerification({ slug: "weather", fetchImpl })
          : searchClawHubSkills({ query: "calendar", fetchImpl });

      await expect(result).rejects.toThrow(
        `ClawHub ${requestPath} response exceeded ${maxMiB * 1024 * 1024} bytes`,
      );
      // Cancel at the cap before allocating a contiguous copy of the oversized body.
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds oversized ClawHub error bodies to a short collapsed snippet", async () => {
    const oversized = "boom ".repeat(64 * 1024); // ~320 KiB error body
    let error: unknown;
    try {
      await searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response(oversized, { status: 500, headers: { "retry-after": "0" } }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.startsWith("ClawHub /api/v1/search failed (500): ")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
    // prefix + 400-char snippet + "…" stays far below the raw ~320 KiB body.
    expect(message.length).toBeLessThanOrEqual(500);
  });
});
