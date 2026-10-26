import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createPinnedLookup,
  type LookupFn,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
  resolveSsrFPolicyForUrl,
  SsrFBlockedError,
  type SsrFPolicy,
} from "./ssrf.js";

const ipv4 = { address: "160.79.104.10", family: 4 };
const ipv6 = { address: "2607:6bc0::10", family: 6 };

function lookupResult(
  lookup: ReturnType<typeof createPinnedLookup>,
  options?: { family?: number; all?: boolean },
) {
  let called = false;
  const pending = new Promise<unknown>((resolve, reject) => {
    const callback = (error: Error | null, address: string | unknown[], family?: number) => {
      called = true;
      if (error) {
        reject(error);
      } else {
        resolve(Array.isArray(address) ? address : { address, family });
      }
    };
    if (options) {
      lookup("example.com", options, callback);
    } else {
      lookup("example.com", callback);
    }
  });
  expect(called).toBe(false);
  return pending;
}

describe("ssrf pinning", () => {
  it.each(["success", "cancel"] as const)(
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
          dns.resolve([ipv4]);
          await expect(result).resolves.toMatchObject({ addresses: [ipv4.address] });
        } else {
          caller.abort(reason);
          expect(await Promise.race([settled, setImmediate("DNS still pending")])).toBe(reason);
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

  it("keeps single-address lookups on IPv4 while exposing both validated families to Happy Eyeballs", async () => {
    const { lookup } = await resolvePinnedHostnameWithPolicy("example.com", {
      lookupFn: async () => [ipv6, ipv4],
    });
    await expect(lookupResult(lookup)).resolves.toEqual(ipv4);
    await expect(lookupResult(lookup)).resolves.toEqual(ipv4);
    await expect(lookupResult(lookup, { all: true })).resolves.toEqual([ipv4, ipv6]);
    await expect(lookupResult(lookup, { family: 6 })).resolves.toEqual(ipv6);
  });

  it("supports IPv6-only DNS answers for all-address lookups", async () => {
    const { lookup } = await resolvePinnedHostnameWithPolicy("example.com", {
      lookupFn: async () => [ipv6],
    });
    await expect(lookupResult(lookup, { all: true })).resolves.toEqual([ipv6]);
  });

  it.each([
    ["example.com", [ipv4, { address: "fd00::1", family: 6 }], undefined, 1],
    ["8.8.2056", [ipv4], undefined, 0],
    ["localhost", [{ address: "0.0.0.0", family: 4 }], { allowedHostnames: ["localhost"] }, 1],
  ] satisfies Array<[string, Awaited<ReturnType<LookupFn>>, SsrFPolicy | undefined, number]>)(
    "rejects unsafe DNS or literals for %s",
    async (hostname, answers, policy, calls) => {
      const lookupFn = vi.fn(async () => [...answers]);
      await expect(resolvePinnedHostnameWithPolicy(hostname, { lookupFn, policy })).rejects.toThrow(
        SsrFBlockedError,
      );
      expect(lookupFn).toHaveBeenCalledTimes(calls);
    },
  );

  it("fails loud when a pinned lookup is created without any addresses", () => {
    expect(() => createPinnedLookup({ hostname: "example.com", addresses: [] })).toThrow(
      "Pinned lookup requires at least one address for example.com",
    );
  });

  it.each([
    [" TRACKER.Example.COM... ", " tracker.example.com. "],
    ["ads.example.com", "*.example.com"],
  ])("blocks configured pattern %s / %s before DNS and allow rules", async (hostname, pattern) => {
    const lookupFn = vi.fn(async () => [ipv4]);
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

  it("uses DNS family metadata for ordering (not address string heuristics)", async () => {
    const lookup: LookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 6 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 4 },
    ]);

    const pinned = await resolvePinnedHostname("example.com", lookup);
    expect(pinned.addresses).toEqual(["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"]);
  });
});
