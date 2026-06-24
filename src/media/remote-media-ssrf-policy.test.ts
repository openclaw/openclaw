import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectRemoteMediaSsrfPolicy } from "./remote-media-ssrf-policy.js";

describe("projectRemoteMediaSsrfPolicy", () => {
  it("keeps fake-IP compatibility flags without forwarding web_fetch host restrictions", () => {
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          fetch: {
            ssrfPolicy: {
              allowRfc2544BenchmarkRange: true,
              allowIpv6UniqueLocalRange: false,
              hostnameAllowlist: ["content.example.com"],
            },
          },
        },
      },
    };

    expect(projectRemoteMediaSsrfPolicy(cfg)).toEqual({
      allowRfc2544BenchmarkRange: true,
      allowIpv6UniqueLocalRange: false,
    });
  });

  it("returns no media policy when web_fetch only restricts hostnames", () => {
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          fetch: {
            ssrfPolicy: { hostnameAllowlist: ["content.example.com"] },
          },
        },
      },
    };

    expect(projectRemoteMediaSsrfPolicy(cfg)).toBeUndefined();
  });
});
