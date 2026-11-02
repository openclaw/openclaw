import type { LookupAddress } from "node:dns";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
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
const withAuthority = <T>(run: () => Promise<T>) => withChannelReadAuthority(() => undefined, run);

class SdkCallbackMatrixClient extends MatrixClient {
  async runSdkDecryptionCallback(callback: () => Promise<void>): Promise<void> {
    const event = this.client.getEventMapper({ decrypt: false })({ type: "m.room.encrypted" });
    vi.spyOn(event, "isBeingDecrypted").mockReturnValue(true);
    vi.spyOn(event, "getDecryptionPromise").mockImplementation(callback);
    await this.client.decryptEventIfNeeded(event);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])("guards SDK callback scope: closed=%s", async (closeB) => {
  lookup.mockReset().mockResolvedValue(DNS_ANSWER);
  const dnsStarted = createDeferred<void>();
  const dnsResult = createDeferred<LookupAddress[]>();
  const finishB = createDeferred<void>();
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
    await withAuthority(async () => {
      decryption = client.runSdkDecryptionCallback(() =>
        withAuthority(async () => {
          nestedRequest = client.getUserProfile("@nested:example.org");
          await finishB.promise;
        }),
      );
      await dnsStarted.promise;
      if (closeB) {
        finishB.resolve();
        await decryption;
      }

      // Resume DNS outside B's final fence while A and the generation remain live.
      const result = closeB
        ? expect(nestedRequest).rejects.toThrow("Channel read authority is no longer active.")
        : expect(nestedRequest).resolves.toEqual(PROFILE);
      dnsResult.resolve(DNS_ANSWER);
      await result;
      expect(runtimeFetch).toHaveBeenCalledTimes(closeB ? 0 : 1);

      finishB.resolve();
      await decryption;
    });
  } finally {
    finishB.resolve();
    dnsResult.resolve(DNS_ANSWER);
    await Promise.allSettled([decryption, nestedRequest]);
    await client.stopWithoutPersist();
  }
});
