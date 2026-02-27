import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

describe("sandbox seatbelt config", () => {
  it("accepts seatbelt backend with a profile", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            backend: "seatbelt",
            seatbelt: {
              profile: "demo-open",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.backend).toBe("seatbelt");
      expect(res.config.agents?.defaults?.sandbox?.seatbelt?.profile).toBe("demo-open");
    }
  });

  it("rejects defaults seatbelt backend without a resolved profile", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            backend: "seatbelt",
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path.includes("agents.defaults.sandbox.seatbelt.profile") ||
            issue.message.includes("sandbox.seatbelt.profile"),
        ),
      ).toBe(true);
    }
  });

  it("allows agent seatbelt backend to inherit profile from defaults", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            backend: "seatbelt",
            seatbelt: {
              profile: "demo-open",
            },
          },
        },
        list: [
          {
            id: "worker",
            sandbox: {
              backend: "seatbelt",
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects agent seatbelt backend when profile is missing from agent and defaults", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            backend: "docker",
          },
        },
        list: [
          {
            id: "worker",
            sandbox: {
              backend: "seatbelt",
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path.includes("agents.list[0].sandbox.seatbelt.profile") ||
            issue.message.includes("resolved profile"),
        ),
      ).toBe(true);
    }
  });

  it("rejects traversal-like seatbelt profile names", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            backend: "seatbelt",
            seatbelt: {
              profile: "../../etc/evil",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path.includes("seatbelt.profile") ||
            issue.message.toLowerCase().includes("profile name must use only"),
        ),
      ).toBe(true);
    }
  });

  it("rejects seatbelt backend on non-darwin platforms", () => {
    const res = withPlatform("linux", () =>
      validateConfigObject({
        agents: {
          defaults: {
            sandbox: {
              backend: "seatbelt",
              seatbelt: {
                profile: "demo-open",
              },
            },
          },
        },
      }),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.message.toLowerCase().includes("darwin"))).toBe(true);
      expect(res.issues.some((issue) => issue.message.includes("openclaw doctor"))).toBe(true);
    }
  });
});
