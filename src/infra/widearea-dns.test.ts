import { describe, expect, it } from "vitest";

import {
  renderWideAreaBridgeZoneText,
  WIDE_AREA_DISCOVERY_DOMAIN,
} from "./widearea-dns.js";

describe("wide-area DNS-SD zone rendering", () => {
  it("renders a clawdis.internal zone with bridge PTR/SRV/TXT records", () => {
    const txt = renderWideAreaBridgeZoneText({
      serial: 2025121701,
      bridgePort: 18790,
      displayName: "Mac Studio (Clawdis)",
      tailnetIPv4: "100.123.224.76",
      tailnetIPv6: "fd7a:115c:a1e0::8801:e04c",
      hostLabel: "studio-london",
      instanceLabel: "studio-london",
    });

    expect(txt).toContain(`$ORIGIN ${WIDE_AREA_DISCOVERY_DOMAIN}`);
    expect(txt).toContain(`studio-london IN A 100.123.224.76`);
    expect(txt).toContain(`studio-london IN AAAA fd7a:115c:a1e0::8801:e04c`);
    expect(txt).toContain(
      `_clawdis-bridge._tcp IN PTR studio-london._clawdis-bridge._tcp`,
    );
    expect(txt).toContain(
      `studio-london._clawdis-bridge._tcp IN SRV 0 0 18790 studio-london`,
    );
    expect(txt).toContain(`displayName=Mac Studio (Clawdis)`);
  });

  it("includes tailnetDns when provided", () => {
    const txt = renderWideAreaBridgeZoneText({
      serial: 2025121701,
      bridgePort: 18790,
      displayName: "Mac Studio (Clawdis)",
      tailnetIPv4: "100.123.224.76",
      tailnetDns: "peters-mac-studio-1.sheep-coho.ts.net",
      hostLabel: "studio-london",
      instanceLabel: "studio-london",
    });

    expect(txt).toContain(`tailnetDns=peters-mac-studio-1.sheep-coho.ts.net`);
  });
});
