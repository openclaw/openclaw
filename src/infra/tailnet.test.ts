import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { listTailnetAddresses } from "./tailnet.js";

describe("tailnet address detection", () => {
  it("detects tailscale IPv4 and IPv6 addresses", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [
        { address: "127.0.0.1", family: "IPv4", internal: true, netmask: "" },
      ] as unknown as os.NetworkInterfaceInfo[],
      utun9: [
        {
          address: "100.123.224.76",
          family: "IPv4",
          internal: false,
          netmask: "",
        },
        {
          address: "fd7a:115c:a1e0::8801:e04c",
          family: "IPv6",
          internal: false,
          netmask: "",
        },
      ] as unknown as os.NetworkInterfaceInfo[],
    });

    const out = listTailnetAddresses();
    expect(out.ipv4).toEqual(["100.123.224.76"]);
    expect(out.ipv6).toEqual(["fd7a:115c:a1e0::8801:e04c"]);
  });
});
