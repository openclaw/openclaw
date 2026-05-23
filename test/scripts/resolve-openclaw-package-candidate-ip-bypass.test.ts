import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadUrl } from "../../scripts/resolve-openclaw-package-candidate.mjs";

const tempDirs: string[] = [];

type LookupAddress = { address: string; family: number };

function lookupAddresses(addresses: LookupAddress[]) {
  return async () => addresses;
}

function unexpectedFetch(): never {
  throw new Error("downloadUrl should reject before fetching");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("package URL SSRF IPv6 transition address blocking", () => {
  it.each([
    ["IPv4-mapped loopback hex", "::ffff:7f00:1"],
    ["IPv4-mapped RFC1918 hex", "::ffff:a00:1"],
    ["IPv4-compatible loopback hex", "::7f00:1"],
    ["well-known NAT64 to loopback", "64:ff9b::7f00:1"],
    ["local-use NAT64 to RFC1918", "64:ff9b:1::a00:1"],
    ["6to4 embedded RFC1918", "2002:0a00:0001::"],
    ["Teredo embedded loopback", "2001:0:0:0:0:0:80ff:fffe"],
    ["ISATAP embedded RFC1918", "fe80::5efe:a00:1"],
  ])("rejects %s DNS result before fetch", async (_name, address) => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-ip-bypass-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");

    await expect(
      downloadUrl("https://packages.example/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address, family: 6 }]),
      }),
    ).rejects.toThrow(/private\/internal\/special-use/iu);
  });

  it("rejects IPv4-mapped loopback URL literals before fetch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-package-ip-bypass-"));
    tempDirs.push(dir);
    const target = path.join(dir, "openclaw.tgz");

    await expect(
      downloadUrl("https://[::ffff:7f00:1]/openclaw.tgz", target, {
        fetchImpl: unexpectedFetch,
        lookupHost: lookupAddresses([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow(/private\/internal\/special-use/iu);
  });
});
