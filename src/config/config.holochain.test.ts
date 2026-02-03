import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "./types.js";
import { applyHolochainDefaults } from "./defaults.js";

describe("Holochain config defaults", () => {
  test("should not apply defaults when mode is disabled", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "disabled",
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result).toEqual(cfg);
  });

  test("should not apply defaults when holochain is undefined", () => {
    const cfg: OpenClawConfig = {};
    const result = applyHolochainDefaults(cfg);
    expect(result).toEqual(cfg);
  });

  test("should apply conductor defaults when conductor is needed", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
        conductor: {},
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.conductor?.adminPort).toBe(4444);
    expect(result.holochain?.conductor?.appPort).toBe(4445);
    expect(result.holochain?.conductor?.autoStart).toBe(true);
  });

  test("should apply session storage defaults in hybrid mode", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.sessionStorage?.fallbackToLocal).toBe(true);
    expect(result.holochain?.sessionStorage?.retentionDays).toBe(30);
    expect(result.holochain?.sessionStorage?.encryption).toBe(true);
  });

  test("should apply session storage defaults in full-p2p mode", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "full-p2p",
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.sessionStorage?.fallbackToLocal).toBe(true);
    expect(result.holochain?.sessionStorage?.retentionDays).toBe(30);
    expect(result.holochain?.sessionStorage?.encryption).toBe(true);
  });

  test("should preserve existing conductor config", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
        conductor: {
          adminPort: 5555,
          appPort: 5556,
          autoStart: false,
          binPath: "/custom/path/holochain",
        },
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.conductor?.adminPort).toBe(5555);
    expect(result.holochain?.conductor?.appPort).toBe(5556);
    expect(result.holochain?.conductor?.autoStart).toBe(false);
    expect(result.holochain?.conductor?.binPath).toBe("/custom/path/holochain");
  });

  test("should apply security defaults when security config exists", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
        security: {
          promptValidation: true,
        },
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.security?.rateLimitPerHour).toBe(10);
  });

  test("should apply A2A defaults when A2A config exists", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
        a2a: {
          enabled: true,
        },
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.a2a?.commissionRate).toBe(0.05);
    expect(result.holochain?.a2a?.maxPingPongTurns).toBe(5);
  });

  test("should apply P2P defaults when P2P config exists", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "full-p2p",
        p2p: {
          enabled: true,
        },
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.p2p?.kitsuneTransport).toBe(true);
    expect(result.holochain?.p2p?.networkId).toBe("openclaw-mainnet");
  });

  test("should preserve existing A2A commission rate", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
        a2a: {
          enabled: true,
          commissionRate: 0.1,
        },
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.a2a?.commissionRate).toBe(0.1);
  });

  test("should not mutate original config", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
        conductor: {},
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(cfg.holochain?.conductor?.adminPort).toBeUndefined();
    expect(result.holochain?.conductor?.adminPort).toBeDefined();
  });

  test("should handle partial session storage config", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
        sessionStorage: {
          enabled: true,
          encryption: false,
        },
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.sessionStorage?.enabled).toBe(true);
    expect(result.holochain?.sessionStorage?.encryption).toBe(false);
    expect(result.holochain?.sessionStorage?.fallbackToLocal).toBe(true);
    expect(result.holochain?.sessionStorage?.retentionDays).toBe(30);
  });

  test("should handle full config with all defaults already set", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
        conductor: {
          adminPort: 4444,
          appPort: 4445,
          autoStart: true,
        },
        sessionStorage: {
          fallbackToLocal: true,
          retentionDays: 30,
          encryption: true,
        },
        security: {
          rateLimitPerHour: 10,
        },
        a2a: {
          enabled: true,
          commissionRate: 0.05,
          maxPingPongTurns: 5,
        },
        p2p: {
          enabled: true,
          kitsuneTransport: true,
          networkId: "openclaw-mainnet",
        },
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result).toEqual(cfg);
  });

  test("should not create conductor when mode is hybrid but no conductor-related config", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.conductor).toBeUndefined();
    expect(result.holochain?.sessionStorage).toBeDefined();
  });

  test("should create conductor when autoStart is explicitly true", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
        conductor: {
          autoStart: true,
        },
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.conductor).toBeDefined();
    expect(result.holochain?.conductor?.autoStart).toBe(true);
  });

  test("should create conductor when conductor config exists", () => {
    const cfg: OpenClawConfig = {
      holochain: {
        mode: "hybrid",
        conductor: {
          binPath: "/custom/path",
        },
      },
    };
    const result = applyHolochainDefaults(cfg);
    expect(result.holochain?.conductor).toBeDefined();
    expect(result.holochain?.conductor?.adminPort).toBe(4444);
  });
});
