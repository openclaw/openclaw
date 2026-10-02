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

const HOMESERVER = "http://127.0.0.1:8008";
const READ_PATH = "/_matrix/client/v3/rooms/%21room%3Amatrix.test/messages";
const PAYLOAD = JSON.stringify({ chunk: [{ event_id: "$fixture", content: { body: "context" } }] });
const DNS_ANSWER: LookupAddress[] = [{ address: "127.0.0.1", family: 4 }];
const CLOSED_AUTHORITY = "Channel read authority is no longer active.";
const TRANSPORTS = ["performMatrixRequest JSON", "SDK fetch"] as const;

const withRead = <T>(run: () => Promise<T>) => withChannelReadAuthority(() => undefined, run);

function deferDns() {
  const started = createDeferred<void>();
  const result = createDeferred<LookupAddress[]>();
  lookup.mockImplementationOnce(() => {
    started.resolve();
    return result.promise;
  });
  return { started: started.promise, release: () => result.resolve(DNS_ANSWER) };
}

class TransportMatrixClient extends MatrixClient {
  async readTransport(transport: (typeof TRANSPORTS)[number], path: string): Promise<unknown> {
    return transport === "SDK fetch"
      ? (await this.client.http.fetch(`${HOMESERVER}${path}`)).text()
      : this.doRequest("GET", path);
  }
}

const clients: TransportMatrixClient[] = [];

function createReader(
  transport: (typeof TRANSPORTS)[number],
  body: BodyInit = PAYLOAD,
  close?: () => Promise<void>,
) {
  const runtimeFetch = vi.fn<typeof fetch>(async () => new Response(body));
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", {
    Agent: class MockAgent {
      close = close;
    },
    EnvHttpProxyAgent: function MockEnvHttpProxyAgent() {},
    ProxyAgent: function MockProxyAgent() {},
    fetch: runtimeFetch,
  });
  const client = new TransportMatrixClient(HOMESERVER, "fixture-token", {
    localTimeoutMs: 5000,
    ssrfPolicy: { allowPrivateNetwork: true },
  });
  clients.push(client);
  return { client, runtimeFetch, read: client.readTransport.bind(client, transport) };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  lookup.mockReset().mockResolvedValue(DNS_ANSWER);
});

afterEach(async () => {
  try {
    await Promise.all(clients.splice(0).map((client) => client.stopWithoutPersist()));
  } finally {
    vi.unstubAllGlobals();
  }
});

describe.each(TRANSPORTS)("%s read authority", (transport) => {
  it.each([
    { name: "read closing during initial DNS", redirect: false, closeClient: false },
    { name: "read closing during redirect DNS", redirect: true, closeClient: false },
    { name: "client closing during DNS", redirect: false, closeClient: true },
  ])("stops physical I/O after $name", async ({ redirect, closeClient }) => {
    const { client, read, runtimeFetch } = createReader(transport);
    if (redirect) {
      lookup.mockResolvedValueOnce(DNS_ANSWER);
      runtimeFetch.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: READ_PATH } }),
      );
    }
    const dns = deferDns();

    const pending = await withRead(async () => {
      const request = read(redirect ? "/redirect" : READ_PATH);
      const rejected = expect(request).rejects.toThrow(
        closeClient ? "Matrix client generation is no longer active." : CLOSED_AUTHORITY,
      );
      await dns.started;
      if (closeClient) {
        await client.stopWithoutPersist();
        dns.release();
        await rejected;
      }
      return { rejected };
    });
    if (!closeClient) {
      await withRead(async () => {
        dns.release();
        await pending.rejected;
      });
    }
    expect(runtimeFetch.mock.calls.map(([url]) => url)).toEqual(
      redirect ? [`${HOMESERVER}/redirect`] : [],
    );
  });

  it.each(["body consumption", "dispatcher cleanup"])(
    "rejects a closed read after %s",
    async (phase) => {
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      const pause = async () => {
        started.resolve();
        await finish.promise;
      };
      const consumingBody = phase === "body consumption";
      const body = consumingBody
        ? new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                await pause();
                controller.enqueue(Buffer.from(PAYLOAD));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          )
        : PAYLOAD;
      const { read, runtimeFetch } = createReader(
        transport,
        body,
        consumingBody ? undefined : pause,
      );
      const pending = await withRead(async () => {
        const request = read(READ_PATH);
        await started.promise;
        return { request };
      });
      const rejected = expect(pending.request).rejects.toThrow(CLOSED_AUTHORITY);
      finish.resolve();
      await rejected;
      expect(runtimeFetch.mock.calls.map(([url]) => url)).toEqual([`${HOMESERVER}${READ_PATH}`]);
    },
  );
});

it("reuses an SDK fetch without poisoning a valid read or reviving its closed first read", async () => {
  const dns = deferDns();
  const first = await withRead(async () => {
    const { read, runtimeFetch } = createReader("SDK fetch");
    const rejected = expect(read(`${READ_PATH}?limit=1`)).rejects.toMatchObject({
      message: CLOSED_AUTHORITY,
    });
    await dns.started;
    return { read, runtimeFetch, rejected };
  });

  await withRead(async () => {
    await expect(first.read(`${READ_PATH}?limit=2`)).resolves.toBe(PAYLOAD);
    dns.release();
    await first.rejected;
  });
  expect(first.runtimeFetch.mock.calls.map(([url]) => url)).toEqual([
    `${HOMESERVER}${READ_PATH}?limit=2`,
  ]);
});
