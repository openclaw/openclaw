import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { blockedIpv6MulticastLiterals } from "../../../packages/net-policy/src/ip-test-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  assertHostnameAllowedWithPolicy,
  createPinnedLookup,
  type LookupFn,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
  SsrFBlockedError,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  isSameSsrFPolicy,
  mergeSsrFPolicies,
  resolveSsrFPolicyForUrl,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
  ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
  type SsrFPolicy,
} from "./ssrf.js";

const ipv4 = { address: "160.79.104.10", family: 4 };
const ipv6 = { address: "2607:6bc0::10", family: 6 };
type DnsAnswers = Awaited<ReturnType<LookupFn>>;

function lookupResult(
  lookup: ReturnType<typeof createPinnedLookup>,
  options?: { family?: number; all?: boolean },
) {
  let called = false;
  const pending = new Promise<unknown>((resolve, reject) => {
    const callback = (error: Error | null, address: string | unknown[], family?: number) => {
      called = true;
      return error
        ? reject(error)
        : resolve(Array.isArray(address) ? address : { address, family });
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

const blockedIpCases = [
  ...`
    198.18.0.1 198.19.255.254 198.51.100.42 203.0.113.10
    192.0.0.8 192.0.2.1 192.88.99.1 224.0.0.1 239.255.255.255 240.0.0.1 255.255.255.255
    ::ffff:127.0.0.1 ::ffff:198.18.0.1 64:ff9b::198.51.100.42
    0:0:0:0:0:ffff:7f00:1 0000:0000:0000:0000:0000:ffff:7f00:0001
    ::127.0.0.1 0:0:0:0:0:0:7f00:1 [0:0:0:0:0:ffff:7f00:1]
    ::ffff:169.254.169.254 0:0:0:0:0:ffff:a9fe:a9fe 64:ff9b::127.0.0.1
    64:ff9b::169.254.169.254 64:ff9b:1:c0a8:1:100:: 64:ff9b:1:a00:0:100::
    64:ff9b:1::8.8.8.8 64:ff9b:1:808:808:808:808:808 64:ff9b:1:808:808:808:a9fe:a9fe
    2002:7f00:0001:: 2002:a9fe:a9fe:: 2001:0000:0:0:0:0:80ff:fefe
    2001:0000:0:0:0:0:3f57:fefe 2002:c612:0001:: :: ::1 fe80::1%lo0 fd00::1 fec0::1 100::1
    2001:2::1 2001:20::1 2001:db8::1 2001:db8:1234::5efe:127.0.0.1
    2001:db8:1234:1:200:5efe:7f00:1
    :::: 2001:db8::gggg
    0177.0.0.1 0x7f.0.0.1 127.1 2130706433 0x7f000001 017700000001
    8.8.2056 0x08080808 08.0.0.1 0x7g.0.0.1 127..0.1 999.1.1.1
  `
    .trim()
    .split(/\s+/),
  ...blockedIpv6MulticastLiterals,
];

const host = "api.example.com";
const baseOrigin = `https://${host}`;
describe("SSRF policy and pinning", () => {
  it("classifies blocked ip literals as private", () => {
    for (const address of blockedIpCases) {
      expect(isPrivateIpAddress(address)).toBe(true);
    }
  });
  it.each([
    [ssrfPolicyFromHttpBaseUrlAllowedHostname, { allowedHostnames: [host] }],
    [ssrfPolicyFromHttpBaseUrlAllowedOrigin, { allowedOrigins: [baseOrigin] }],
    [
      ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist,
      {
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
        hostnameAllowlist: [host],
      },
    ],
  ] as const)("%s normalizes HTTP base URLs and rejects invalid inputs", (build, expected) => {
    expect(build("")).toBeUndefined();
    expect(build("not-a-url")).toBeUndefined();
    expect(build(`ftp://${host}`)).toBeUndefined();
    expect(build(` ${baseOrigin}/v1?token=redacted `)).toEqual(expected);
  });
  it.each([
    ["http://10.0.0.5:4321", "http://10.0.0.5:1234", {}],
    ["http://[fd00::1]:11434", "http://[fd00::1]:11434", { allowedHostnames: ["fd00::1"] }],
  ] as const)("trusts only exact origins: %s / %s", (url, origin, trusted) => {
    const policy = { allowedOrigins: [origin] };
    expect(resolveSsrFPolicyForUrl(new URL(`${url}/v1/chat/completions`), policy)).toEqual({
      ...policy,
      ...trusted,
    });
  });
  it("blocks reserved hostname with repeated trailing dots", () => {
    expect(() => assertHostnameAllowedWithPolicy("db.internal...")).toThrow(/blocked/i);
  });

  // #74351: dual-stack fake-IP proxies need independent benchmark and ULA exemptions.
  it.each([
    ["::ffff:198.18.0.1", { allowRfc2544BenchmarkRange: true }, false],
    ["fdff::dead:beef", { allowIpv6UniqueLocalRange: true }, false],
    ["198.18.0.1", { allowIpv6UniqueLocalRange: true }, true],
  ] as const)("applies independent fake-IP exemptions for %s", (value, policy, expected) => {
    expect(isBlockedHostnameOrIp(value, policy)).toBe(expected);
  });
  it.each<[keyof SsrFPolicy, string[], string[]]>([
    ["allowedOrigins", ["https://A/a", "https://b"], ["https://b", "https://a/b"]],
    ["allowedHostnames", ["b", "A"], ["a", "B"]],
    ["hostnameAllowlist", ["*.test", "a.test"], ["a.test", "*.test"]],
    ["blockedHostnames", ["a", " *.TEST. ", "a"], ["*.test", "A"]],
  ])("compares %s semantically", (key, a, b) => {
    expect(isSameSsrFPolicy({ [key]: a }, { [key]: b })).toBe(true);
  });
  // #74351: changing ULA policy must invalidate consumers' policy caches.
  it.each<[SsrFPolicy, SsrFPolicy, boolean]>([
    [{}, { blockedHostnames: [] }, true],
    [{}, { blockedHostnames: ["a"] }, false],
    [{ blockedHostnames: ["a"] }, { blockedHostnames: ["*.test"] }, false],
    [
      { dangerouslyAllowPrivateNetwork: true },
      { dangerouslyAllowPrivateNetwork: true, allowRfc2544BenchmarkRange: true },
      false,
    ],
    [
      { allowPrivateNetwork: true },
      { allowPrivateNetwork: true, allowIpv6UniqueLocalRange: true },
      false,
    ],
    [{ allowIpv6UniqueLocalRange: true }, { allowIpv6UniqueLocalRange: true }, true],
  ])("compares policy %j / %j", (a, b, expected) => {
    expect(isSameSsrFPolicy(a, b)).toBe(expected);
  });
  it("retains every configured block when combining policies and trust exceptions", () => {
    const policy = mergeSsrFPolicies(
      { blockedHostnames: ["a"] },
      undefined,
      { blockedHostnames: [] },
      { blockedHostnames: ["*.ads", "a"], allowedHostnames: ["a"] },
    );
    expect(policy?.blockedHostnames).toEqual(["a", "*.ads"]);
    for (const blocked of ["a", "pixel.ads"]) {
      expect(() => assertHostnameAllowedWithPolicy(blocked, policy)).toThrow(
        /configured blocklist/,
      );
    }
  });

  it.each(["success", "cancel"] as const)(
    "detaches the DNS abort listener after %s",
    async (outcome) => {
      const caller = new AbortController();
      const dns = createDeferredCore<DnsAnswers>();
      const reason = new Error("DNS lifecycle stopped");
      const result = resolvePinnedHostnameWithPolicy("example.com", {
        lookupFn: () => dns.promise,
        signal: caller.signal,
      });
      const settled = result.catch((error: unknown) => error);
      try {
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

  it("prefers IPv4 for single lookups and exposes both validated families", async () => {
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

  it.each<[string, DnsAnswers, SsrFPolicy | undefined, number]>([
    ["example.com", [ipv4, { address: "fd00::1", family: 6 }], undefined, 1],
    ["8.8.2056", [ipv4], undefined, 0],
    ["localhost", [{ address: "0.0.0.0", family: 4 }], { allowedHostnames: ["localhost"] }, 1],
  ])("rejects unsafe DNS or literals for %s", async (hostname, answers, policy, calls) => {
    const lookupFn = vi.fn(async () => [...answers]);
    await expect(resolvePinnedHostnameWithPolicy(hostname, { lookupFn, policy })).rejects.toThrow(
      SsrFBlockedError,
    );
    expect(lookupFn).toHaveBeenCalledTimes(calls);
  });

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
    const lookup: LookupFn = async () => [
      { address: "93.184.216.34", family: 6 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 4 },
    ];

    const pinned = await resolvePinnedHostname("example.com", lookup);
    expect(pinned.addresses).toEqual(["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"]);
  });
});
