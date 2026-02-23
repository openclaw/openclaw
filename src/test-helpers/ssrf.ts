import { vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";

export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  const lookupMock = (async (_hostname: string, options?: unknown) => {
    const records = addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
    const requestedFamily =
      typeof options === "number"
        ? options
        : options && typeof options === "object" && "family" in options
          ? (options as { family?: unknown }).family
          : undefined;
    const filtered =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((entry) => entry.family === requestedFamily)
        : records;
    const resolved = (filtered.length > 0 ? filtered : records).map((entry) => ({
      address: entry.address,
      family: entry.family,
    }));
    const useAll =
      Boolean(
        options &&
        typeof options === "object" &&
        "all" in options &&
        (options as { all?: unknown }).all === true,
      ) || options === undefined;
    return useAll ? resolved : (resolved[0] ?? { address: "127.0.0.1", family: 4 });
  }) as ssrf.LookupFn;

  const resolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;
  const resolvePinnedHostname = ssrf.resolvePinnedHostname;

  // Keep both helpers in sync so tests remain stable as call sites migrate.
  vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(async (hostname, params) =>
    resolvePinnedHostnameWithPolicy(hostname, { ...params, lookupFn: lookupMock }),
  );
  return vi
    .spyOn(ssrf, "resolvePinnedHostname")
    .mockImplementation(async (hostname) => resolvePinnedHostname(hostname, lookupMock));
}
