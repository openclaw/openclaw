import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  fetchNpmRegistryPackumentWithRetry,
  fetchNpmRegistryTarballWithRetry,
  resolveNpmDistTagMirrorAuth,
  resolveNpmPublishPlan,
  resolveNpmVersionPublicationDecision,
  resolvePublishedNpmVersionRoute,
  shouldRequireNpmDistTagMirrorAuth,
} from "../scripts/lib/npm-publish-plan.mjs";

function registryResponse(params: {
  status?: number;
  body?: string;
  bodyError?: Error;
  cancel?: () => void;
}): Response {
  const status = params.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    body: {
      cancel: async () => {
        params.cancel?.();
      },
    },
    text: async () => {
      if (params.bodyError) {
        throw params.bodyError;
      }
      return params.body ?? "{}";
    },
  } as unknown as Response;
}

function fetchPackument(
  options: Omit<
    Parameters<typeof fetchNpmRegistryPackumentWithRetry>[0],
    "packageName" | "packageUrl"
  >,
) {
  return fetchNpmRegistryPackumentWithRetry({
    packageName: "@openclaw/meta-provider",
    packageUrl: "https://registry.npmjs.org/%40openclaw%2Fmeta-provider",
    ...options,
  });
}

const noRetry = async () => {
  throw new Error("unexpected retry");
};

function cancellableResponse(status: number, cancel: () => void, headers: HeadersInit = {}) {
  return new Response(new ReadableStream({ cancel }), { status, headers });
}

async function expectTarballFailure(
  options: Parameters<typeof fetchNpmRegistryTarballWithRetry>[0],
  error: string | { code: string },
) {
  const fetchImpl = vi.fn(options.fetchImpl);
  const result = fetchNpmRegistryTarballWithRetry({ ...options, fetchImpl, sleep: noRetry });
  if (typeof error === "string") {
    await expect(result).rejects.toThrow(error);
  } else {
    await expect(result).rejects.toMatchObject(error);
  }
  expect(fetchImpl).toHaveBeenCalledOnce();
}

describe("fetchNpmRegistryPackumentWithRetry", () => {
  it("revalidates a version missing from abbreviated metadata through the exact full endpoint", async () => {
    const exactVersion = "2026.10.2";
    const requested: Array<{ url: string; accept: string | null }> = [];
    const packument = {
      name: "@openclaw/meta-provider",
      versions: { "2026.10.1": { name: "@openclaw/meta-provider", version: "2026.10.1" } },
      "dist-tags": { latest: exactVersion },
    };
    const exact = {
      name: "@openclaw/meta-provider",
      version: exactVersion,
      dist: { integrity: "sha512-fixture" },
    };
    const result = await fetchPackument({
      exactVersion,
      fetchImpl: async (input, init) => {
        requested.push({
          url: input,
          accept: new Headers(init.headers).get("accept"),
        });
        return Response.json(input.endsWith(`/${exactVersion}`) ? exact : packument);
      },
    });

    expect(requested).toEqual([
      {
        url: "https://registry.npmjs.org/%40openclaw%2Fmeta-provider",
        accept: "application/vnd.npm.install-v1+json",
      },
      {
        url: `https://registry.npmjs.org/%40openclaw%2Fmeta-provider/${exactVersion}`,
        accept: "application/json",
      },
    ]);
    expect(result).toEqual({
      status: 200,
      ok: true,
      packument: {
        ...packument,
        versions: { ...packument.versions, [exactVersion]: exact },
      },
    });
  });

  it("requires exact-version metadata to match the requested package identity", async () => {
    await expect(
      fetchPackument({
        exactVersion: "2026.10.2",
        fetchImpl: async (input) =>
          input.endsWith("/2026.10.2")
            ? Response.json({ name: "@openclaw/other", version: "2026.10.2" })
            : Response.json({ versions: {}, "dist-tags": { latest: "2026.10.2" } }),
      }),
    ).rejects.toThrow("mismatched package metadata");
  });

  it("rejects an unsafe exact-version selector before a second registry read", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ versions: {}, "dist-tags": {} }));
    await expect(fetchPackument({ exactVersion: "..", fetchImpl })).rejects.toThrow(
      "invalid exact npm version selector",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("bounds decoded packument bytes and cancels an oversized stream without retrying", async () => {
    let cancelled = false;
    await expect(
      fetchPackument({
        maxBytes: 16,
        sleep: noRetry,
        fetchImpl: async () => {
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode("123456789"));
              },
              cancel() {
                cancelled = true;
              },
            }),
          );
        },
      }),
    ).rejects.toMatchObject({ code: "ETOOBIG" });
    expect(cancelled).toBe(true);
  });

  it.each(["before-request", "during-body", "during-retry-sleep"] as const)(
    "honors owning collection abort %s without another HTTP attempt",
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error("owning collection stopped");
      let requests = 0;
      let cancelled = false;
      let slept = false;
      if (stage === "before-request") {
        controller.abort(reason);
      }
      await expect(
        fetchPackument({
          maxBytes: 128,
          signal: controller.signal,
          fetchImpl: async () => {
            requests += 1;
            if (stage === "during-retry-sleep") {
              return new Response("", { status: 503 });
            }
            return new Response(
              new ReadableStream<Uint8Array>({
                pull() {
                  controller.abort(reason);
                },
                cancel() {
                  cancelled = true;
                },
              }),
            );
          },
          sleep: async () => {
            slept = true;
            controller.abort(reason);
            controller.signal.throwIfAborted();
          },
        }),
      ).rejects.toBe(reason);
      expect(requests).toBe(stage === "before-request" ? 0 : 1);
      expect(cancelled).toBe(stage === "during-body");
      expect(slept).toBe(stage === "during-retry-sleep");
    },
  );

  it.each([true, false])("bounds retries for body failures (recovers: %s)", async (recovers) => {
    let fetchCalls = 0;
    let cancelCalls = 0;
    const waits: number[] = [];
    const packument = { versions: { "2026.7.1-beta.3": {} } };
    const result = fetchPackument({
      fetchImpl: async () => {
        fetchCalls += 1;
        if (recovers && fetchCalls > 1) {
          return registryResponse({ body: JSON.stringify(packument) });
        }
        return registryResponse({
          bodyError: recovers
            ? new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } })
            : new DOMException("timed out", "AbortError"),
          cancel: () => {
            cancelCalls += 1;
          },
        });
      },
      sleep: async (delayMs) => {
        waits.push(delayMs);
      },
      createSignal: () => new AbortController().signal,
    });
    if (recovers) {
      await expect(result).resolves.toEqual({ status: 200, ok: true, packument });
    } else {
      await expect(result).rejects.toThrow(
        "npm publication-route probe (https://registry.npmjs.org/%40openclaw%2Fmeta-provider) did not return a stable response",
      );
    }
    expect(fetchCalls).toBe(recovers ? 2 : 3);
    expect(cancelCalls).toBe(recovers ? 1 : 3);
    expect(waits).toEqual(recovers ? [1000] : [1000, 2000]);
  });

  it.each([
    ["invalid JSON", "returned invalid JSON"],
    ["certificate failure", new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } })],
  ] as const)("does not retry permanent %s", async (_label, error) => {
    const fetchImpl = vi.fn(async () => {
      if (error instanceof Error) {
        throw error;
      }
      return new Response("{");
    });
    const result = fetchPackument({ fetchImpl, sleep: noRetry });
    if (error instanceof Error) {
      await expect(result).rejects.toBe(error);
    } else {
      await expect(result).rejects.toThrow(error);
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns a stable missing-package status without retrying", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => registryResponse({ status: 404, cancel }));
    const result = await fetchPackument({
      fetchImpl,
      sleep: noRetry,
      createSignal: () => new AbortController().signal,
    });

    expect(result).toEqual({ status: 404, ok: false, packument: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("fetchNpmRegistryTarballWithRetry", () => {
  const packageName = "@openclaw/fixture";
  const packageUrl = "https://registry.npmjs.org/@openclaw/fixture/-/fixture.tgz";
  const bytes = Buffer.from("qualified package bytes");
  const fetchTarball = (
    options: Omit<
      Parameters<typeof fetchNpmRegistryTarballWithRetry>[0],
      "packageName" | "packageUrl" | "maxBytes"
    > & { packageUrl?: string },
  ) =>
    fetchNpmRegistryTarballWithRetry({
      packageName,
      packageUrl,
      maxBytes: bytes.length,
      ...options,
    });
  const fails = (options: Parameters<typeof fetchTarball>[0], error: string | { code: string }) =>
    expectTarballFailure({ packageName, packageUrl, maxBytes: bytes.length, ...options }, error);

  it("recovers rate limiting using only the original tarball URL", async () => {
    const requests: string[] = [];
    const waits: number[] = [];
    const cancel = vi.fn();
    const result = await fetchTarball({
      fetchImpl: async (url) => {
        requests.push(url);
        if (requests.length !== 1) {
          return new Response(bytes);
        }
        return cancellableResponse(429, cancel, { "retry-after": "2" });
      },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    expect(result).toEqual(bytes);
    expect(requests).toEqual([packageUrl, packageUrl]);
    expect(waits).toEqual([2000]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([403, 404, 302])(
    "does not retry or follow permanent HTTP %s responses",
    async (status) => {
      const cancel = vi.fn();
      await fails(
        {
          fetchImpl: async () =>
            cancellableResponse(status, cancel, {
              location: "https://other.example/package.tgz",
            }),
        },
        `HTTP ${status}`,
      );
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each(["header", "stream"])("rejects oversized %s bytes without retry", async (kind) => {
    await fails(
      {
        fetchImpl: async () =>
          new Response(Buffer.concat([bytes, Buffer.from("extra")]), {
            headers: kind === "header" ? { "content-length": String(bytes.length + 5) } : {},
          }),
      },
      { code: "ETOOBIG" },
    );
  });

  it.each(["seconds", "date"])(
    "does not violate Retry-After %s to fit its deadline",
    async (kind) => {
      const retryAfter = kind === "seconds" ? "60" : new Date(Date.now() + 60_000).toUTCString();
      await fails(
        {
          deadlineMs: Date.now() + 1000,
          fetchImpl: async () =>
            new Response("rate limited", {
              status: 429,
              headers: { "retry-after": retryAfter },
            }),
        },
        "deadline would be exceeded before the permitted retry",
      );
    },
  );

  it("recovers a real HTTP disconnect within the shared GET retry budget", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503).end("temporarily unavailable");
      } else if (requests === 2) {
        response.writeHead(200, { "content-length": String(bytes.length) });
        response.write(bytes.subarray(0, 3));
        setImmediate(() => response.destroy());
      } else {
        response.end(bytes);
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP listener");
      }
      const result = await fetchTarball({
        packageUrl: `http://127.0.0.1:${address.port}/fixture.tgz`,
        timeoutMs: 1000,
        sleep: async () => {},
      });
      expect(result).toEqual(bytes);
      expect(requests).toBe(3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("resolvePublishedNpmVersionRoute", () => {
  it.each([
    ["missing beta", "2026.7.1-beta.3", {}, "npm-tag-repair"],
    ["lagging latest", "2026.7.1", { latest: "2026.6.11", beta: "2026.7.1" }, "npm-tag-repair"],
    ["lagging mirror", "2026.7.1", { latest: "2026.7.1", beta: "2026.7.1-beta.3" }, "npm-mirror"],
    [
      "ahead omitted mirror",
      "2026.7.1",
      { latest: "2026.7.1", beta: "2026.8.1-beta.1" },
      "npm-readback",
      "2026.8.1-beta.1",
    ],
    ["complete stable", "2026.7.1", { latest: "2026.7.1", beta: "2026.7.1" }, "npm-readback"],
  ] as const)("routes %s selectors", (_label, version, distTags, route, currentBeta?: string) => {
    expect(
      resolvePublishedNpmVersionRoute({
        packageVersion: version,
        publishPlan: resolveNpmPublishPlan(version, currentBeta),
        distTags,
      }),
    ).toBe(route);
  });

  it.each([
    ["incomparable beta", "2026.7.1-beta.3", { beta: "not-a-version" }],
    ["conflicting beta", "2026.7.1-beta.3", { beta: " 2026.7.1-beta.3 " }],
    ["incomparable mirror", "2026.7.1", { latest: "2026.7.1", beta: "not-a-version" }],
    [
      "unsafe mirror before primary repair",
      "2026.7.1",
      { latest: "2026.6.11", beta: "not-a-version" },
    ],
    ["ahead mirror", "2026.7.1", { latest: "2026.7.1", beta: "2026.8.1-beta.1" }],
  ])("rejects %s selectors", (_label, version, distTags) => {
    expect(() =>
      resolvePublishedNpmVersionRoute({
        packageVersion: version,
        publishPlan: resolveNpmPublishPlan(version),
        distTags,
      }),
    ).toThrow("cannot be safely moved");
  });

  it.each([
    ["published latest superseded", { latest: "2026.9.7", beta: "2026.9.7" }, true, "2026.9.7"],
    [
      "unpublished behind ahead selector",
      { latest: "2026.9.7" },
      false,
      null,
      'npm dist-tag "latest" points to "2026.9.7" and cannot be safely moved to "2026.9.6" (ahead)',
    ],
    ["unpublished behind lagging selector", { latest: "2026.9.5" }, false],
  ] as const)(
    "decides publication for %s",
    (_label, distTags, published, supersededBy?: string | null, error?: string) => {
      const version = "2026.9.6";
      const publishPlan = resolveNpmPublishPlan(version);
      const decide = () =>
        resolveNpmVersionPublicationDecision({
          packageVersion: version,
          publishPlan: published ? { ...publishPlan, mirrorDistTags: ["beta"] } : publishPlan,
          distTags,
          published,
        });
      if (error) {
        expect(decide).toThrow(error);
        return;
      }
      expect(decide()).toEqual({
        route: published ? "npm-readback" : null,
        supersededBy: supersededBy ?? null,
      });
    },
  );
});

describe("shouldRequireNpmDistTagMirrorAuth", () => {
  it.each([
    ["dry run", "--dry-run", "2026.4.1", undefined, false],
    ["unauthenticated publish", "--publish", "2026.4.1", undefined, true],
    ["no mirror", "--publish", "2026.4.1-beta.1", undefined, false],
    ["authenticated publish", "--publish", "2026.4.1", "token", false],
  ] as const)("requires mirror auth for %s", (_label, mode, version, npmToken, required) => {
    const plan = resolveNpmPublishPlan(version);
    const auth = resolveNpmDistTagMirrorAuth({ npmToken });
    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode,
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(required);
  });

  it("treats stable correction releases as latest publishes with beta mirroring", () => {
    expect(resolveNpmPublishPlan("2026.4.1-1")).toEqual({
      channel: "stable",
      publishTag: "latest",
      mirrorDistTags: ["beta"],
    });
  });

  it("rejects alpha publication instead of falling through to latest", () => {
    expect(() => resolveNpmPublishPlan("2026.4.1-alpha.1")).toThrow("Alpha releases are retired;");
    expect(() => resolveNpmPublishPlan("2026.4.1", undefined, "alpha")).toThrow(
      "Alpha releases are retired;",
    );
  });
});

describe("extended-stable npm publish override", () => {
  it("publishes final patch 33 and later to extended-stable without mirrors", () => {
    const expected = {
      channel: "stable",
      publishTag: "extended-stable",
      mirrorDistTags: [],
    };
    expect(resolveNpmPublishPlan("2026.7.33", undefined, "extended-stable")).toEqual(expected);
    expect(resolveNpmPublishPlan("2026.7.34", "2026.8.1-beta.1", "extended-stable")).toEqual(
      expected,
    );
  });

  it.each([
    ["pre-.33 final", "2026.7.32", "extended-stable"],
    ["correction", "2026.7.33-1", "extended-stable"],
    ["alpha", "2026.7.33-alpha.1", "extended-stable"],
    ["beta", "2026.7.33-beta.1", "extended-stable"],
    ["open override", "2026.7.33", "latest"],
  ])("rejects %s releases", (_label, version, override) => {
    expect(() => resolveNpmPublishPlan(version, undefined, override)).toThrow();
  });
});
