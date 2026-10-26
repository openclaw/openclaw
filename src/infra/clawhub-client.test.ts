import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { fetchClawHubJson, type ClawHubFetchOptions } from "./clawhub-client.js";
import { retryClawHubRead } from "./clawhub-retry.js";
import { fetchClawHubSkillVerification, searchClawHubSkills } from "./clawhub-skills.js";
import { captureClawHubResponse } from "./clawhub.test-support.js";
import { makeStallingStream } from "./http-body.test-support.js";

const search = (options: ClawHubFetchOptions) =>
  searchClawHubSkills({ query: "calendar", ...options });
const respond = (body: BodyInit | null, init?: ResponseInit) =>
  captureClawHubResponse(() => new Response(body, init));

async function writeConfigFile(configPath: string, contents: string) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, contents, "utf8");
}

describe("clawhub client", () => {
  const originalEnv = captureEnv(["APPDATA", "HOME", "XDG_CONFIG_HOME"]);

  async function searchAuthorizationHeader(): Promise<string | null> {
    const request = captureClawHubResponse(() => Response.json({ results: [] }));
    await expect(search({})).resolves.toStrictEqual([]);
    return new Headers(request.init()?.headers).get("Authorization");
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
    ["with malformed JSON", '{"token":"fixture-malformed-secret", invalid}'],
  ])(
    "does not fall back to a legacy token when the canonical config exists %s",
    async (description, contents) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        if (description === "with malformed JSON") {
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            "ClawHub sign-in configuration could not be loaded; repair it or sign in again. Continuing without a saved token.",
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
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
    respond("Rate limit exceeded", {
      status: 429,
      headers: { "RateLimit-Reset": "invalid", "Retry-After": "7" },
    });
    await expect(search({})).rejects.toThrow(
      /Rate limit exceeded \(resets in 7s\) Sign in for higher rate limits\.$/,
    );
  });

  it.each(["GET", "POST"] as const)(
    "replays a pre-header timeout only for %s reads",
    async (method) => {
      let attempts = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
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
      });
      const result = fetchClawHubJson({
        path: "/timeout",
        method,
        skipAuth: true,
        timeoutMs: 5,
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
    respond(
      Buffer.concat([
        Buffer.from('{"results":[{"slug":"'),
        Buffer.from([0xff]),
        Buffer.from('"}]}'),
      ]),
    );
    await expect(search({})).rejects.toThrow("ClawHub /api/v1/search returned malformed JSON");
  });

  it.each([
    { status: 200, error: "ClawHub /api/v1/search response stalled after 5ms" },
    { status: 500, error: "ClawHub /api/v1/search failed (500): Server Error" },
  ])("times out and cancels stalled $status bodies", async ({ status, error }) => {
    const cancellations: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const cancel = vi.fn();
      cancellations.push(cancel);
      return new Response(makeStallingStream([new TextEncoder().encode("partial")], cancel), {
        headers: { "content-type": "text/plain", "retry-after": "0" },
        status,
        statusText: status === 500 ? "Server Error" : undefined,
      });
    });
    await expect(search({ timeoutMs: 5 })).rejects.toThrow(error);
    for (const cancel of cancellations) {
      expect(cancel).toHaveBeenCalledTimes(1);
    }
    expect(cancellations.at(-1)?.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("bounds oversized verification JSON and cancels the stream", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(512 * 1024).fill("x".charCodeAt(0));
    const body = makeStallingStream(
      Array.from({ length: 130 }, () => chunk),
      cancel,
    );
    respond(body, { status: 200, headers: { "content-type": "application/json" } });
    const result = fetchClawHubSkillVerification({ slug: "weather" });

    await expect(result).rejects.toThrow(
      `ClawHub /api/v1/skills/weather/verify response exceeded ${64 * 1024 * 1024} bytes`,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized ClawHub error bodies to a short collapsed snippet", async () => {
    respond("boom ".repeat(64 * 1024), { status: 500, headers: { "retry-after": "0" } });
    const error = await search({}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.startsWith("ClawHub /api/v1/search failed (500): ")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(500);
  });
});

function retryResponse(first: Response | Error, retryRateLimit = false) {
  const delays: number[] = [];
  const request = vi.fn(async () => ({ response: new Response("ok") }));
  request.mockImplementationOnce(async () => {
    if (first instanceof Error) {
      throw first;
    }
    return { response: first };
  });
  const result = retryClawHubRead(request, {
    retryRateLimit,
    disposeRetry: async ({ response }) => {
      await response.body?.cancel();
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { result, request, delays };
}

it.each([
  ["ignores fractional delay-seconds", "1.5", 1_000],
  ["honors a valid HTTP-date", "Tue, 02 Mar 2027 23:59:35 GMT", 5_000],
] as const)("Retry-After %s through the shared parser", async (_name, retryAfter, delay) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-03-02T23:59:30.000Z"));
  try {
    const { result, delays } = retryResponse(
      new Response("limited", {
        status: 503,
        headers: { "Retry-After": retryAfter },
      }),
    );
    expect(await (await result).response.text()).toBe("ok");
    expect(delays).toEqual([delay]);
  } finally {
    vi.useRealTimers();
  }
});

it("does not retry permanent certificate failures", async () => {
  const failure = new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } });
  const { result, request, delays } = retryResponse(failure);
  await expect(result).rejects.toBe(failure);
  expect(request).toHaveBeenCalledTimes(1);
  expect(delays).toEqual([]);
});

it("does not retry 429 unless the caller enables rate-limit retries", async () => {
  const defaults = retryResponse(new Response("limited", { status: 429 }));
  expect((await defaults.result).response.status).toBe(429);
  expect(defaults.request).toHaveBeenCalledTimes(1);
  const optedIn = retryResponse(new Response("limited", { status: 429 }), true);
  expect(await (await optedIn.result).response.text()).toBe("ok");
  expect(optedIn.request).toHaveBeenCalledTimes(2);
});
