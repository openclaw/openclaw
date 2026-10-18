import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { fetchClawHubJson, type ClawHubFetchOptions } from "./clawhub-client.js";
import { fetchClawHubSkillVerification, searchClawHubSkills } from "./clawhub-skills.js";

const search = (options: ClawHubFetchOptions) =>
  searchClawHubSkills({ query: "calendar", ...options });

function createStalledBodyResponse(firstChunk: string, init: ResponseInit = {}) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk));
    },
    cancel,
  });
  return {
    response: new Response(body, init),
    cancel,
  };
}

async function writeConfigFile(configPath: string, contents: string) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, contents, "utf8");
}

describe("clawhub client", () => {
  const originalEnv = captureEnv(["APPDATA", "HOME", "XDG_CONFIG_HOME"]);

  async function searchAuthorizationHeader(): Promise<string | null> {
    let authorization: string | null = null;
    await expect(
      search({
        fetchImpl: async (_input, init) => {
          authorization = new Headers(init?.headers).get("Authorization");
          return Response.json({ results: [] });
        },
      }),
    ).resolves.toStrictEqual([]);
    return authorization;
  }

  afterEach(() => {
    vi.restoreAllMocks();
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
      await withTestDir({ prefix: "openclaw-clawhub-appdata-" }, async (appDataRoot) => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        setTestEnvValue("APPDATA", appDataRoot);
        deleteTestEnvValue("XDG_CONFIG_HOME");
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
    "falls back to XDG_CONFIG_HOME for ClawHub request auth on macOS",
    async () => {
      await withTestDir({ prefix: "openclaw-clawhub-home-" }, async (fakeHome) => {
        const xdgRoot = path.join(fakeHome, "xdg");
        vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
        setTestEnvValue("XDG_CONFIG_HOME", xdgRoot);
        await writeConfigFile(
          path.join(xdgRoot, "clawhub", "config.json"),
          '{"token":"fixture-xdg-token"}',
        );
        await expect(searchAuthorizationHeader()).resolves.toBe("Bearer fixture-xdg-token");
      });
    },
  );

  it("uses a valid Retry-After hint when RateLimit-Reset is malformed", async () => {
    process.env.CLAWHUB_CONFIG_PATH = path.join(os.tmpdir(), "openclaw-no-clawhub-config");
    await expect(
      search({
        fetchImpl: async () =>
          new Response("Rate limit exceeded", {
            status: 429,
            headers: { "RateLimit-Reset": "invalid", "Retry-After": "7" },
          }),
      }),
    ).rejects.toThrow(/Rate limit exceeded \(resets in 7s\) Sign in for higher rate limits\.$/);
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
      search({
        fetchImpl: async () =>
          new Response(
            Buffer.concat([
              Buffer.from('{"results":[{"slug":"'),
              Buffer.from([0xff]),
              Buffer.from('"}]}'),
            ]),
          ),
      }),
    ).rejects.toThrow("ClawHub /api/v1/search returned malformed JSON");
  });

  it.each([
    { status: 200, error: "ClawHub /api/v1/search response stalled after 5ms" },
    { status: 500, error: "ClawHub /api/v1/search failed (500): Server Error" },
  ])("times out and cancels stalled $status bodies", async ({ status, error }) => {
    const stalledResponses: ReturnType<typeof createStalledBodyResponse>[] = [];

    await expect(
      search({
        timeoutMs: 5,
        fetchImpl: async () => {
          const stalled = createStalledBodyResponse(
            status === 200 ? '{"results":[' : "partial error",
            {
              headers: { "content-type": "text/plain", "retry-after": "0" },
              status,
              statusText: status === 500 ? "Server Error" : undefined,
            },
          );
          stalledResponses.push(stalled);
          return stalled.response;
        },
      }),
    ).rejects.toThrow(error);
    for (const stalled of stalledResponses) {
      expect(stalled.cancel).toHaveBeenCalledTimes(1);
    }
    const finalResponse = stalledResponses.at(-1);
    expect(finalResponse?.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("bounds oversized verification JSON and cancels the stream", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(512 * 1024).fill("x".charCodeAt(0));
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 65 * 2) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel,
    });
    const fetchImpl = async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    const result = fetchClawHubSkillVerification({ slug: "weather", fetchImpl });

    await expect(result).rejects.toThrow(
      `ClawHub /api/v1/skills/weather/verify response exceeded ${64 * 1024 * 1024} bytes`,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized ClawHub error bodies to a short collapsed snippet", async () => {
    const error = await search({
      fetchImpl: async () =>
        new Response("boom ".repeat(64 * 1024), { status: 500, headers: { "retry-after": "0" } }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.startsWith("ClawHub /api/v1/search failed (500): ")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(500);
  });
});
