// SSRF pinning tests cover DNS pinning behavior, blocked DNS results, hostname
// allowlists, and IPv4/IPv6 address ordering.
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createPinnedLookup,
  type LookupFn,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
  resolveSsrFPolicyForUrl,
  SsrFBlockedError,
} from "./ssrf.js";

function createPublicLookupMock(): LookupFn {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
}

describe("ssrf pinning", () => {
  it.each(["success", "failure", "cancel"] as const)(
    "releases the DNS abort listener after %s without changing errors",
    async (outcome) => {
      const caller = new AbortController();
      const dns = createDeferredCore<Awaited<ReturnType<LookupFn>>>();
      const lookupFn = vi.fn(() => dns.promise);
      const reason = new Error("DNS lifecycle stopped");
      const result = resolvePinnedHostnameWithPolicy("example.com", {
        lookupFn,
        signal: caller.signal,
      });
      const settled = result.catch((error: unknown) => error);
      try {
        expect(lookupFn).toHaveBeenCalledOnce();
        if (outcome === "success") {
          dns.resolve([{ address: "93.184.216.34", family: 4 }]);
          await expect(result).resolves.toMatchObject({ addresses: ["93.184.216.34"] });
        } else {
          if (outcome === "cancel") {
            caller.abort(reason);
          } else {
            dns.reject(reason);
          }
          expect(
            await Promise.race([
              settled,
              new Promise((resolve) => {
                setImmediate(() => resolve("DNS still pending"));
              }),
            ]),
          ).toBe(reason);
        }
        expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      } finally {
        caller.abort(reason);
        // Cancellation must still observe a later DNS rejection.
        dns.reject(reason);
        await settled;
      }
    },
  );

  it("keeps automatic pinned lookups on IPv4 when both address families are available", async () => {
    const lookup = createPinnedLookup({
      hostname: "api.anthropic.com",
      addresses: ["160.79.104.10", "2607:6bc0::10"],
    });
    const lookupDefault = () => {
      let called = false;
      const pending = new Promise<{ address: string; family?: number }>((resolve, reject) => {
        lookup("api.anthropic.com", (err, address, family) => {
          called = true;
          if (err) {
            reject(err);
          } else {
            resolve({ address, family });
          }
        });
      });
      expect(called).toBe(false);
      return pending;
    };
    const lookupWithOptions = (options: { family?: number }) =>
      new Promise<{ address: string; family?: number }>((resolve, reject) => {
        lookup("api.anthropic.com", options, (err, address, family) => {
          if (err) {
            reject(err);
          } else {
            resolve({ address, family });
          }
        });
      });

    await expect(lookupDefault()).resolves.toEqual({ address: "160.79.104.10", family: 4 });
    await expect(lookupDefault()).resolves.toEqual({ address: "160.79.104.10", family: 4 });

    let allCalled = false;
    const all = new Promise<unknown>((resolve, reject) => {
      lookup("api.anthropic.com", { all: true }, (err, addresses) => {
        allCalled = true;
        if (err) {
          reject(err);
        } else {
          resolve(addresses);
        }
      });
    });
    expect(allCalled).toBe(false);
    await expect(all).resolves.toEqual([{ address: "160.79.104.10", family: 4 }]);

    await expect(lookupWithOptions({ family: 6 })).resolves.toEqual({
      address: "2607:6bc0::10",
      family: 6,
    });
  });

  it("fails loud when a pinned lookup is created without any addresses", () => {
    expect(() =>
      createPinnedLookup({
        hostname: "example.com",
        addresses: [],
      }),
    ).toThrow("Pinned lookup requires at least one address for example.com");
  });

  it.each([
    [" TRACKER.Example.COM... ", " tracker.example.com. "],
    ["ads.example.com", "*.example.com"],
  ])("blocks configured pattern %s / %s before DNS and allow rules", async (hostname, pattern) => {
    const lookupFn = createPublicLookupMock();
    const policy = resolveSsrFPolicyForUrl(new URL("https://tracker.example.com"), {
      blockedHostnames: [pattern],
      allowedHostnames: [hostname.trim()],
      allowedOrigins: ["https://tracker.example.com"],
      hostnameAllowlist: ["*.example.com", "*.example"],
      dangerouslyAllowPrivateNetwork: true,
    });

    const result = resolvePinnedHostnameWithPolicy(hostname, { lookupFn, policy });
    await expect(result).rejects.toThrow(SsrFBlockedError);
    await expect(result).rejects.toThrow(/configured blocklist.*blockedHostnames/);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("blocks unsupported short-form IPv4 literals before DNS lookup", async () => {
    const lookup = createPublicLookupMock();

    await expect(resolvePinnedHostnameWithPolicy("8.8.2056", { lookupFn: lookup })).rejects.toThrow(
      SsrFBlockedError,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("uses DNS family metadata for ordering (not address string heuristics)", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 6 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 4 },
    ]) as unknown as LookupFn;

    const pinned = await resolvePinnedHostname("example.com", lookup);
    expect(pinned.addresses).toEqual(["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"]);
  });

  it("accepts dangerouslyAllowPrivateNetwork as an allowPrivateNetwork alias", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

    const pinned = await resolvePinnedHostnameWithPolicy("localhost", {
      lookupFn: lookup,
      policy: { dangerouslyAllowPrivateNetwork: true },
    });
    expect(pinned.hostname).toBe("localhost");
    expect(pinned.addresses).toEqual(["127.0.0.1"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not allow explicit localhost trust to resolve through an unspecified address", async () => {
    const lookup = vi.fn(async () => [{ address: "0.0.0.0", family: 4 }]) as unknown as LookupFn;

    await expect(
      resolvePinnedHostnameWithPolicy("localhost", {
        lookupFn: lookup,
        policy: { allowedHostnames: ["localhost"] },
      }),
    ).rejects.toThrow(SsrFBlockedError);
  });
});
