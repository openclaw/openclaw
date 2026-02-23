import { vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";

export function mockPinnedHostnameResolution(addresses: string[] = ["93.184.216.34"]) {
  const lookupMock: ssrf.LookupFn = async (_hostname, options) => {
    const records = addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
    const requestedFamily = options?.family;
    const filtered =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((entry) => entry.family === requestedFamily)
        : records;
    return (filtered.length > 0 ? filtered : records).map((entry) => ({
      address: entry.address,
      family: entry.family,
    }));
  };

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
