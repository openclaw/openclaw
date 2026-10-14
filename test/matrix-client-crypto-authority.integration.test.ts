import type { LookupAddress } from "node:dns";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MatrixClient } from "../extensions/matrix/test-api.js";
import { withChannelReadAuthority } from "../src/shared/channel-read-authority.js";

const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn<(hostname: string, options: { all: true }) => Promise<LookupAddress[]>>(),
}));

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));

const DNS_ANSWER: LookupAddress[] = [{ address: "127.0.0.1", family: 4 }];
const PROFILE = { displayname: "Nested Matrix reader" };

class SdkCallbackMatrixClient extends MatrixClient {
  async runSdkDecryptionCallback(callback: () => Promise<void>): Promise<void> {
    const event = this.client.getEventMapper({ decrypt: false })({
      room_id: "!room:example.org",
      event_id: "$encrypted",
      sender: "@sender:example.org",
      type: "m.room.encrypted",
      origin_server_ts: 1,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "fixture" },
    });
    // Mock only the SDK event's pending callback; execute the actual client owner.
    vi.spyOn(event, "isBeingDecrypted").mockReturnValue(true);
    vi.spyOn(event, "getDecryptionPromise").mockImplementation(callback);
    await this.client.decryptEventIfNeeded(event);
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
  lookup.mockReset();
  lookup.mockResolvedValue(DNS_ANSWER);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { scope: "closed", closeB: true },
  { scope: "active", closeB: false },
])("honors $scope B authority inside a mocked SDK decryption callback", async ({ closeB }) => {
  const dnsStarted = createDeferred<void>();
  const dnsResult = createDeferred<LookupAddress[]>();
  const finishB = createDeferred<void>();
  const requestReady = createDeferred<{
    request: ReturnType<MatrixClient["getUserProfile"]>;
  }>();
  lookup.mockImplementationOnce(() => {
    dnsStarted.resolve();
    return dnsResult.promise;
  });
  const runtimeFetch = vi.fn<typeof fetch>(async () => Response.json(PROFILE));
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", {
    Agent: function MockAgent() {},
    EnvHttpProxyAgent: function MockEnvHttpProxyAgent() {},
    ProxyAgent: function MockProxyAgent() {},
    fetch: runtimeFetch,
  });
  const client = new SdkCallbackMatrixClient("http://127.0.0.1:8008", "fixture-token", {
    ssrfPolicy: { allowPrivateNetwork: true },
  });
  let decryption: Promise<void> | undefined;
  let nestedRequest: ReturnType<MatrixClient["getUserProfile"]> | undefined;

  try {
    await withChannelReadAuthority(
      () => undefined,
      async () => {
        decryption = client.runSdkDecryptionCallback(async () => {
          await withChannelReadAuthority(
            () => undefined,
            async () => {
              const request = client.getUserProfile("@nested:example.org");
              nestedRequest = request;
              await dnsStarted.promise;
              requestReady.resolve({ request });
              await finishB.promise;
              return { request };
            },
          );
        });
        const { request } = await requestReady.promise;
        if (closeB) {
          finishB.resolve();
          await decryption;
        }

        // Assert the transport promise outside B's final host fence. A and the
        // generation remain live while DNS resumes, so neither can mask B's closure.
        const result = closeB
          ? expect(request).rejects.toThrow("Channel read authority is no longer active.")
          : expect(request).resolves.toEqual(PROFILE);
        dnsResult.resolve(DNS_ANSWER);
        await result;
        expect(runtimeFetch).toHaveBeenCalledTimes(closeB ? 0 : 1);

        finishB.resolve();
        await decryption;
      },
    );
  } finally {
    finishB.resolve();
    dnsResult.resolve(DNS_ANSWER);
    await Promise.allSettled([decryption, nestedRequest]);
    await client.stopWithoutPersist();
  }
});
