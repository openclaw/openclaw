import type { LookupAddress } from "node:dns";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixClient } from "../extensions/matrix/test-api.js";
import { withChannelReadAuthority } from "../src/shared/channel-read-authority.js";

const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn<(hostname: string, options: { all: true }) => Promise<LookupAddress[]>>(),
}));

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const HOMESERVER = "http://127.0.0.1:8008";
const READ_PATH = "/_matrix/client/v3/rooms/%21room%3Amatrix.test/messages";
const PAYLOAD = JSON.stringify({ chunk: [{ event_id: "$fixture", content: { body: "context" } }] });
const DNS_ANSWER: LookupAddress[] = [{ address: "127.0.0.1", family: 4 }];
const CLOSED_AUTHORITY = "Channel read authority is no longer active.";
const TRANSPORTS = ["performMatrixRequest JSON", "performMatrixRequest raw", "SDK fetch"] as const;

class TransportMatrixClient extends MatrixClient {
  async readTransport(transport: (typeof TRANSPORTS)[number], path: string): Promise<unknown> {
    if (transport === "SDK fetch") {
      // The SDK adapter invokes the fetch installed by MatrixClientBase.
      const response = await this.client.http.fetch(`${HOMESERVER}${path}`);
      return await response.text();
    }
    if (transport === "performMatrixRequest raw") {
      const buffer = await this.httpClient.requestRaw({
        method: "GET",
        endpoint: path,
        timeoutMs: 5000,
      });
      return buffer.toString("utf8");
    }
    return await this.doRequest("GET", path);
  }
}

const clients = new Set<TransportMatrixClient>();

function stubRuntimeFetch(fetchImpl: typeof fetch, close?: () => Promise<void>): void {
  vi.stubGlobal(TEST_UNDICI_RUNTIME_DEPS_KEY, {
    Agent: class MockAgent {
      close = close;
    },
    EnvHttpProxyAgent: function MockEnvHttpProxyAgent() {},
    ProxyAgent: function MockProxyAgent() {},
    fetch: fetchImpl,
  });
}

function createReader(transport: (typeof TRANSPORTS)[number]) {
  const client = new TransportMatrixClient(HOMESERVER, "fixture-token", {
    localTimeoutMs: 5000,
    ssrfPolicy: { allowPrivateNetwork: true },
  });
  clients.add(client);
  return {
    client,
    read: (path: string) => client.readTransport(transport, path),
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  lookup.mockReset();
  lookup.mockResolvedValue(DNS_ANSWER);
});

afterEach(async () => {
  const ownedClients = [...clients];
  clients.clear();
  try {
    await Promise.all(ownedClients.map((client) => client.stopWithoutPersist()));
  } finally {
    vi.unstubAllGlobals();
  }
});

describe.each(TRANSPORTS)("%s read authority", (transport) => {
  it("returns an allowed read while its host scope is active", async () => {
    const runtimeFetch = vi.fn<typeof fetch>(async () => new Response(PAYLOAD));
    stubRuntimeFetch(runtimeFetch);
    const { read } = createReader(transport);

    await expect(
      withChannelReadAuthority(
        () => undefined,
        () => read(READ_PATH),
      ),
    ).resolves.toBe(PAYLOAD);
    expect(runtimeFetch.mock.calls.map(([url]) => url)).toEqual([`${HOMESERVER}${READ_PATH}`]);
  });

  it.each([
    { name: "initial DNS", redirect: false },
    { name: "redirect DNS", redirect: true },
  ])("stops the next physical request when the read closes during $name", async ({ redirect }) => {
    const dnsStarted = createDeferred<void>();
    const dnsResult = createDeferred<LookupAddress[]>();
    const runtimeFetch = vi.fn<typeof fetch>(async () => new Response(PAYLOAD));
    if (redirect) {
      lookup.mockResolvedValueOnce(DNS_ANSWER);
      runtimeFetch.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: READ_PATH } }),
      );
    }
    lookup.mockImplementationOnce(() => {
      dnsStarted.resolve();
      return dnsResult.promise;
    });
    stubRuntimeFetch(runtimeFetch);
    const { read } = createReader(transport);

    // Return the pending transport promise without awaiting it so the host scope
    // closes here; its own result fence cannot make a broken transport pass.
    const pending = await withChannelReadAuthority(
      () => undefined,
      async () => {
        const request = read(redirect ? "/redirect" : READ_PATH);
        await dnsStarted.promise;
        return { request };
      },
    );
    const rejected = expect(pending.request).rejects.toThrow(CLOSED_AUTHORITY);

    await withChannelReadAuthority(
      () => undefined,
      async () => {
        dnsResult.resolve(DNS_ANSWER);
        await rejected;
      },
    );
    expect(runtimeFetch.mock.calls.map(([url]) => url)).toEqual(
      redirect ? [`${HOMESERVER}/redirect`] : [],
    );
  });

  it("rejects its own late result after the read closes during body consumption", async () => {
    const bodyStarted = createDeferred<void>();
    const deliverBody = createDeferred<void>();
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          bodyStarted.resolve();
          await deliverBody.promise;
          controller.enqueue(Buffer.from(PAYLOAD));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const runtimeFetch = vi.fn<typeof fetch>(async () => new Response(stream));
    stubRuntimeFetch(runtimeFetch);
    const { read } = createReader(transport);

    const pending = await withChannelReadAuthority(
      () => undefined,
      async () => {
        const request = read(READ_PATH);
        await bodyStarted.promise;
        return { request };
      },
    );
    const rejected = expect(pending.request).rejects.toThrow(CLOSED_AUTHORITY);
    deliverBody.resolve();

    await rejected;
    expect(runtimeFetch.mock.calls.map(([url]) => url)).toEqual([`${HOMESERVER}${READ_PATH}`]);
  });

  it("stops physical I/O when the client closes during DNS with read authority still active", async () => {
    const dnsStarted = createDeferred<void>();
    const dnsResult = createDeferred<LookupAddress[]>();
    lookup.mockImplementationOnce(() => {
      dnsStarted.resolve();
      return dnsResult.promise;
    });
    const runtimeFetch = vi.fn<typeof fetch>(async () => new Response(PAYLOAD));
    stubRuntimeFetch(runtimeFetch);
    const { client, read } = createReader(transport);

    await withChannelReadAuthority(
      () => undefined,
      async () => {
        const rejected = expect(read(READ_PATH)).rejects.toThrow(
          "Matrix client generation is no longer active.",
        );
        await dnsStarted.promise;
        await client.stopWithoutPersist();
        dnsResult.resolve(DNS_ANSWER);
        await rejected;
      },
    );
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it("rechecks result authority after dispatcher cleanup", async () => {
    const cleanupStarted = createDeferred<void>();
    const finishCleanup = createDeferred<void>();
    const runtimeFetch = vi.fn<typeof fetch>(async () => new Response(PAYLOAD));
    stubRuntimeFetch(runtimeFetch, async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
    });
    const { read } = createReader(transport);

    const pending = await withChannelReadAuthority(
      () => undefined,
      async () => {
        const request = read(READ_PATH);
        await cleanupStarted.promise;
        return { request };
      },
    );
    const rejected = expect(pending.request).rejects.toThrow(CLOSED_AUTHORITY);
    finishCleanup.resolve();
    await rejected;
    expect(runtimeFetch.mock.calls.map(([url]) => url)).toEqual([`${HOMESERVER}${READ_PATH}`]);
  });
});

it("reuses an SDK fetch without poisoning a valid read or reviving its closed first read", async () => {
  const dnsStarted = createDeferred<void>();
  const firstDns = createDeferred<LookupAddress[]>();
  lookup.mockImplementationOnce(() => {
    dnsStarted.resolve();
    return firstDns.promise;
  });
  const runtimeFetch = vi.fn<typeof fetch>(async () => new Response(PAYLOAD));
  stubRuntimeFetch(runtimeFetch);

  const first = await withChannelReadAuthority(
    () => undefined,
    async () => {
      const { read } = createReader("SDK fetch");
      const result = Promise.allSettled([read(`${READ_PATH}?limit=1`)]);
      await dnsStarted.promise;
      return { read, result };
    },
  );

  await withChannelReadAuthority(
    () => undefined,
    async () => {
      const second = await Promise.allSettled([first.read(`${READ_PATH}?limit=2`)]);
      firstDns.resolve(DNS_ANSWER);
      const firstResult = await first.result;

      expect(second).toEqual([{ status: "fulfilled", value: PAYLOAD }]);
      expect(firstResult).toEqual([
        { status: "rejected", reason: expect.objectContaining({ message: CLOSED_AUTHORITY }) },
      ]);
    },
  );
  expect(runtimeFetch.mock.calls.map(([url]) => url)).toEqual([
    `${HOMESERVER}${READ_PATH}?limit=2`,
  ]);
});
