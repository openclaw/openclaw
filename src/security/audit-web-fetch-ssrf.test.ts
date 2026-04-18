import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { runSecurityAudit } from "./audit.js";

function hasFinding(
  findings: Awaited<ReturnType<typeof runSecurityAudit>>["findings"],
  checkId: string,
  severity?: string,
) {
  return findings.some(
    (finding) => finding.checkId === checkId && (severity == null || finding.severity === severity),
  );
}

async function audit(cfg: OpenClawConfig) {
  return await runSecurityAudit({
    config: cfg,
    includeFilesystem: false,
    includeChannelSecurity: false,
  });
}

describe("security audit web_fetch SSRF findings", () => {
  it("warns when the global web_fetch SSRF default enables private-network access", async () => {
    const res = await audit({
      tools: {
        web: {
          fetch: {
            ssrfPolicy: {
              dangerouslyAllowPrivateNetwork: true,
            },
          },
        },
      },
    });

    expect(
      hasFinding(
        res.findings,
        "tools.web_fetch.ssrf_policy.default_private_network_enabled",
        "warn",
      ),
    ).toBe(true);
  });

  it("reports global narrow web_fetch SSRF exceptions as info", async () => {
    const res = await audit({
      tools: {
        web: {
          fetch: {
            ssrfPolicy: {
              allowedHostnames: ["matrix.home.arpa"],
              hostnameAllowlist: ["*.corp.example"],
              allowRfc2544BenchmarkRange: true,
            },
          },
        },
      },
    });

    expect(
      hasFinding(res.findings, "tools.web_fetch.ssrf_policy.default_narrow_exceptions", "info"),
    ).toBe(true);
  });

  it("warns when a named agent widens web_fetch SSRF private-network access", async () => {
    const res = await audit({
      tools: {
        web: {
          fetch: {
            ssrfPolicy: {
              dangerouslyAllowPrivateNetwork: false,
            },
          },
        },
      },
      agents: {
        list: [
          {
            id: "ops",
            tools: {
              web: {
                fetch: {
                  ssrfPolicy: {
                    dangerouslyAllowPrivateNetwork: true,
                  },
                },
              },
            },
          },
        ],
      },
    });

    expect(
      hasFinding(
        res.findings,
        "agents.ops.tools.web_fetch.ssrf_policy.private_network_enabled",
        "warn",
      ),
    ).toBe(true);
  });

  it("reports named-agent narrow web_fetch SSRF exceptions as info", async () => {
    const res = await audit({
      agents: {
        list: [
          {
            id: "ops",
            tools: {
              web: {
                fetch: {
                  ssrfPolicy: {
                    allowedHostnames: ["matrix.home.arpa"],
                    allowRfc2544BenchmarkRange: true,
                  },
                },
              },
            },
          },
        ],
      },
    });

    expect(
      hasFinding(res.findings, "agents.ops.tools.web_fetch.ssrf_policy.narrow_exceptions", "info"),
    ).toBe(true);
  });

  it("emits no web_fetch SSRF findings when neither global nor agent config widens access", async () => {
    const res = await audit({
      tools: {
        web: {
          fetch: {
            ssrfPolicy: {
              dangerouslyAllowPrivateNetwork: false,
            },
          },
        },
      },
      agents: {
        list: [
          {
            id: "ops",
            tools: {
              web: {
                fetch: {
                  ssrfPolicy: {
                    dangerouslyAllowPrivateNetwork: false,
                  },
                },
              },
            },
          },
        ],
      },
    });

    expect(
      hasFinding(res.findings, "tools.web_fetch.ssrf_policy.default_private_network_enabled"),
    ).toBe(false);
    expect(hasFinding(res.findings, "tools.web_fetch.ssrf_policy.default_narrow_exceptions")).toBe(
      false,
    );
    expect(
      hasFinding(res.findings, "agents.ops.tools.web_fetch.ssrf_policy.private_network_enabled"),
    ).toBe(false);
    expect(
      hasFinding(res.findings, "agents.ops.tools.web_fetch.ssrf_policy.narrow_exceptions"),
    ).toBe(false);
  });
});
