// npm publish plan tests validate package publish planning rules.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
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

describe("fetchNpmRegistryPackumentWithRetry", () => {
  it("bounds decoded packument bytes and cancels an oversized stream without retrying", async () => {
    let requests = 0;
    let cancelled = false;
    await expect(
      fetchNpmRegistryPackumentWithRetry({
        packageName: "fixture",
        packageUrl: "https://registry.npmjs.org/fixture",
        maxBytes: 16,
        fetchImpl: async () => {
          requests += 1;
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
    expect(requests).toBe(1);
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
        fetchNpmRegistryPackumentWithRetry({
          packageName: "fixture",
          packageUrl: "https://registry.npmjs.org/fixture",
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
    const result = fetchNpmRegistryPackumentWithRetry({
      packageName: "@openclaw/meta-provider",
      packageUrl: "https://registry.npmjs.org/%40openclaw%2Fmeta-provider",
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

  it("rejects completed invalid JSON without retry or recoverable publication deferral", async () => {
    let requests = 0;
    await expect(
      fetchNpmRegistryPackumentWithRetry({
        packageName: "@openclaw/demo",
        packageUrl: "https://registry.npmjs.org/%40openclaw%2Fdemo",
        fetchImpl: async () => {
          requests += 1;
          return new Response("{");
        },
        sleep: async () => {
          throw new Error("invalid content must not retry");
        },
      }),
    ).rejects.toThrow("returned invalid JSON");
    expect(requests).toBe(1);
  });

  it.each(["CERT_HAS_EXPIRED", "ERR_INVALID_URL"])(
    "does not retry permanent fetch TypeError %s",
    async (code) => {
      let requests = 0;
      const error = new TypeError("fetch failed", { cause: { code } });
      await expect(
        fetchNpmRegistryPackumentWithRetry({
          packageName: "fixture",
          packageUrl: "https://registry.npmjs.org/fixture",
          fetchImpl: async () => {
            requests += 1;
            throw error;
          },
          sleep: async () => {
            throw new Error("permanent failure must not retry");
          },
        }),
      ).rejects.toBe(error);
      expect(requests).toBe(1);
    },
  );

  it("returns a stable missing-package status without retrying", async () => {
    let fetchCalls = 0;
    let cancelCalls = 0;

    const result = await fetchNpmRegistryPackumentWithRetry({
      packageName: "@openclaw/meta-provider",
      packageUrl: "https://registry.npmjs.org/%40openclaw%2Fmeta-provider",
      fetchImpl: async () => {
        fetchCalls += 1;
        return registryResponse({
          status: 404,
          cancel: () => {
            cancelCalls += 1;
          },
        });
      },
      sleep: async () => {
        throw new Error("stable 404 must not sleep");
      },
      createSignal: () => new AbortController().signal,
    });

    expect(result).toEqual({ status: 404, ok: false, packument: null });
    expect(fetchCalls).toBe(1);
    expect(cancelCalls).toBe(1);
  });
});

describe("fetchNpmRegistryTarballWithRetry", () => {
  const packageName = "@openclaw/fixture";
  const packageUrl = "https://registry.npmjs.org/@openclaw/fixture/-/fixture.tgz";
  const bytes = Buffer.from("qualified package bytes");

  it.each([503, 429, "connection", "interrupted-body"] as const)(
    "recovers %s using only the original tarball URL",
    async (failure) => {
      const requests: string[] = [];
      const waits: number[] = [];
      let canceled = 0;
      const result = await fetchNpmRegistryTarballWithRetry({
        packageName,
        packageUrl,
        maxBytes: bytes.length,
        fetchImpl: async (url) => {
          requests.push(url);
          if (requests.length !== 1) {
            return new Response(bytes);
          }
          if (failure === "connection") {
            throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
          }
          if (failure === "interrupted-body") {
            let firstChunk = true;
            return new Response(
              new ReadableStream({
                pull(controller) {
                  if (firstChunk) {
                    firstChunk = false;
                    controller.enqueue(bytes.subarray(0, 3));
                  } else {
                    controller.error(
                      new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }),
                    );
                  }
                },
              }),
            );
          }
          return new Response(
            new ReadableStream({
              cancel() {
                canceled += 1;
              },
            }),
            {
              status: failure,
              headers: failure === 429 ? { "retry-after": "2" } : {},
            },
          );
        },
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      });
      expect(result).toEqual(bytes);
      expect(requests).toEqual([packageUrl, packageUrl]);
      expect(waits).toEqual([failure === 429 ? 2000 : 1000]);
      if (typeof failure === "number") {
        expect(canceled).toBe(1);
      }
    },
  );

  it.each([401, 403, 404, 410, 302])(
    "does not retry or follow permanent HTTP %s responses",
    async (status) => {
      let requests = 0;
      let canceled = 0;
      await expect(
        fetchNpmRegistryTarballWithRetry({
          packageName,
          packageUrl,
          maxBytes: bytes.length,
          fetchImpl: async () => {
            requests += 1;
            return new Response(
              new ReadableStream({
                cancel() {
                  canceled += 1;
                },
              }),
              {
                status,
                headers: { location: "https://other.example/package.tgz" },
              },
            );
          },
          sleep: async () => {
            throw new Error("permanent responses must not retry");
          },
        }),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(requests).toBe(1);
      expect(canceled).toBe(1);
    },
  );

  it.each(["header", "stream"])("rejects oversized %s bytes without retry", async (kind) => {
    let requests = 0;
    await expect(
      fetchNpmRegistryTarballWithRetry({
        packageName,
        packageUrl,
        maxBytes: bytes.length,
        fetchImpl: async () => {
          requests += 1;
          return new Response(Buffer.concat([bytes, Buffer.from("extra")]), {
            headers: kind === "header" ? { "content-length": String(bytes.length + 5) } : {},
          });
        },
        sleep: async () => {
          throw new Error("oversized bytes must not retry");
        },
      }),
    ).rejects.toMatchObject({ code: "ETOOBIG" });
    expect(requests).toBe(1);
  });

  it.each(["seconds", "date"])(
    "does not violate Retry-After %s to fit its deadline",
    async (kind) => {
      const retryAfter = kind === "seconds" ? "60" : new Date(Date.now() + 60_000).toUTCString();
      let requests = 0;
      await expect(
        fetchNpmRegistryTarballWithRetry({
          packageName,
          packageUrl,
          maxBytes: bytes.length,
          deadlineMs: Date.now() + 1000,
          fetchImpl: async () => {
            requests += 1;
            return new Response("rate limited", {
              status: 429,
              headers: { "retry-after": retryAfter },
            });
          },
          sleep: async () => {
            throw new Error("deadline must fail before sleeping");
          },
        }),
      ).rejects.toThrow("deadline would be exceeded before the permitted retry");
      expect(requests).toBe(1);
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
      const result = await fetchNpmRegistryTarballWithRetry({
        packageName,
        packageUrl: `http://127.0.0.1:${address.port}/fixture.tgz`,
        maxBytes: bytes.length,
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
    { label: "missing beta", version: "2026.7.1-beta.3", distTags: {}, route: "npm-tag-repair" },
    {
      label: "lagging beta",
      version: "2026.7.1-beta.3",
      distTags: { beta: "2026.7.1-beta.2" },
      route: "npm-tag-repair",
    },
    {
      label: "lagging latest with current mirror",
      version: "2026.7.1",
      distTags: { latest: "2026.6.11", beta: "2026.7.1" },
      route: "npm-tag-repair",
    },
    {
      label: "matching primary with lagging mirror",
      version: "2026.7.1",
      distTags: { latest: "2026.7.1", beta: "2026.7.1-beta.3" },
      route: "npm-mirror",
    },
    {
      label: "ahead omitted mirror",
      version: "2026.7.1",
      distTags: { latest: "2026.7.1", beta: "2026.8.1-beta.1" },
      currentBeta: "2026.8.1-beta.1",
      route: "npm-readback",
    },
    {
      label: "complete beta",
      version: "2026.7.1-beta.3",
      distTags: { beta: "2026.7.1-beta.3" },
      route: "npm-readback",
    },
    {
      label: "complete stable",
      version: "2026.7.1",
      distTags: { latest: "2026.7.1", beta: "2026.7.1" },
      route: "npm-readback",
    },
  ])("routes $label selectors", ({ version, distTags, currentBeta, route }) => {
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
    {
      label: "published beta superseded",
      version: "2026.7.1-beta.3",
      distTags: { beta: "2026.7.1-beta.4" },
      published: true,
      supersededBy: "2026.7.1-beta.4",
    },
    {
      label: "published latest superseded",
      version: "2026.9.6",
      distTags: { latest: "2026.9.7", beta: "2026.9.7" },
      published: true,
      supersededBy: "2026.9.7",
    },
    {
      label: "unpublished behind ahead selector",
      version: "2026.9.6",
      distTags: { latest: "2026.9.7" },
      published: false,
      error:
        'npm dist-tag "latest" points to "2026.9.7" and cannot be safely moved to "2026.9.6" (ahead)',
    },
    {
      label: "unpublished behind lagging selector",
      version: "2026.9.6",
      distTags: { latest: "2026.9.5" },
      published: false,
    },
    {
      label: "unpublished behind placeholder",
      version: "2026.9.6",
      distTags: { latest: "0.0.0" },
      published: false,
    },
    { label: "unpublished missing selector", version: "2026.9.6", distTags: {}, published: false },
  ])("decides publication for $label", ({ version, distTags, published, supersededBy, error }) => {
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
    if (published) {
      expect(
        resolvePublishedNpmVersionRoute({ packageVersion: version, publishPlan, distTags }),
      ).toBe("npm-readback");
    }
  });
});

describe("shouldRequireNpmDistTagMirrorAuth", () => {
  it.each([
    {
      label: "dry run",
      mode: "--dry-run",
      version: "2026.4.1",
      npmToken: undefined,
      required: false,
    },
    {
      label: "unauthenticated publish",
      mode: "--publish",
      version: "2026.4.1",
      npmToken: undefined,
      required: true,
    },
    {
      label: "no mirror",
      mode: "--publish",
      version: "2026.4.1-beta.1",
      npmToken: undefined,
      required: false,
    },
    {
      label: "authenticated publish",
      mode: "--publish",
      version: "2026.4.1",
      npmToken: "token",
      required: false,
    },
  ] as const)(
    "requires mirror auth for $label: $required",
    ({ mode, version, npmToken, required }) => {
      const plan = resolveNpmPublishPlan(version);
      const auth = resolveNpmDistTagMirrorAuth({ npmToken });
      expect(
        shouldRequireNpmDistTagMirrorAuth({
          mode,
          mirrorDistTags: plan.mirrorDistTags,
          hasAuth: auth.hasAuth,
        }),
      ).toBe(required);
    },
  );

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
    expect(resolveNpmPublishPlan("2026.7.33", undefined, "extended-stable")).toEqual({
      channel: "stable",
      publishTag: "extended-stable",
      mirrorDistTags: [],
    });
    expect(resolveNpmPublishPlan("2026.7.34", "2026.8.1-beta.1", "extended-stable")).toEqual({
      channel: "stable",
      publishTag: "extended-stable",
      mirrorDistTags: [],
    });
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
