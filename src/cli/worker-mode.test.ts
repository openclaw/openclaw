import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRegisteredWorkerFactory,
  isWorkerMode,
  parseWorkerModeEnv,
  registerWorkerFactory,
  runWorkerMode,
  type WorkerModeEnv,
} from "./worker-mode.js";

// Reset singleton between every test
afterEach(() => {
  registerWorkerFactory(null);
});

// ---------------------------------------------------------------------------
// isWorkerMode
// ---------------------------------------------------------------------------
describe("isWorkerMode", () => {
  it("returns true for --mode=worker", () => {
    expect(isWorkerMode(["node", "entry.js", "--mode=worker"])).toBe(true);
  });

  it("returns false when --mode=worker appears after --", () => {
    expect(isWorkerMode(["node", "entry.js", "--", "--mode=worker"])).toBe(false);
  });

  it("returns false for --mode=Worker (case-sensitive)", () => {
    expect(isWorkerMode(["node", "entry.js", "--mode=Worker"])).toBe(false);
  });

  it("returns false for --mode=worker2", () => {
    expect(isWorkerMode(["node", "entry.js", "--mode=worker2"])).toBe(false);
  });

  it("returns false for split form --mode worker", () => {
    expect(isWorkerMode(["node", "entry.js", "--mode", "worker"])).toBe(false);
  });

  it("returns false when flag is absent", () => {
    expect(isWorkerMode(["node", "entry.js", "status"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseWorkerModeEnv
// ---------------------------------------------------------------------------
describe("parseWorkerModeEnv", () => {
  const VALID_ENV: Record<string, string> = {
    OPENCLAW_TEAM_NAME: "my-team",
    OPENCLAW_MEMBER_NAME: "researcher",
    OPENCLAW_ROLE: "researcher",
    OPENCLAW_CONFIG_PATH: "/home/user/.openclaw/teams/my-team/config.json",
    OPENCLAW_NOTIFY_PORT: "9100",
  };

  function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(VALID_ENV)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    for (const [k, v] of Object.entries({ ...VALID_ENV, ...overrides })) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  }

  it("returns correct WorkerModeEnv when all vars are set", () => {
    withEnv({}, () => {
      const env = parseWorkerModeEnv();
      expect(env).toEqual({
        teamName: "my-team",
        memberName: "researcher",
        role: "researcher",
        configPath: "/home/user/.openclaw/teams/my-team/config.json",
        notifyPort: 9100,
      });
    });
  });

  for (const key of Object.keys(VALID_ENV)) {
    it(`throws when ${key} is missing`, () => {
      withEnv({ [key]: undefined }, () => {
        expect(() => parseWorkerModeEnv()).toThrow(key);
      });
    });
  }

  it("throws when OPENCLAW_NOTIFY_PORT is NaN", () => {
    withEnv({ OPENCLAW_NOTIFY_PORT: "abc" }, () => {
      expect(() => parseWorkerModeEnv()).toThrow("OPENCLAW_NOTIFY_PORT");
    });
  });

  it("throws when OPENCLAW_NOTIFY_PORT is 0", () => {
    withEnv({ OPENCLAW_NOTIFY_PORT: "0" }, () => {
      expect(() => parseWorkerModeEnv()).toThrow("OPENCLAW_NOTIFY_PORT");
    });
  });

  it("throws when OPENCLAW_NOTIFY_PORT is negative", () => {
    withEnv({ OPENCLAW_NOTIFY_PORT: "-1" }, () => {
      expect(() => parseWorkerModeEnv()).toThrow("OPENCLAW_NOTIFY_PORT");
    });
  });

  it("throws when OPENCLAW_NOTIFY_PORT is a privileged port (80)", () => {
    withEnv({ OPENCLAW_NOTIFY_PORT: "80" }, () => {
      expect(() => parseWorkerModeEnv()).toThrow("OPENCLAW_NOTIFY_PORT");
    });
  });

  it("throws when OPENCLAW_NOTIFY_PORT exceeds 65535", () => {
    withEnv({ OPENCLAW_NOTIFY_PORT: "99999" }, () => {
      expect(() => parseWorkerModeEnv()).toThrow("OPENCLAW_NOTIFY_PORT");
    });
  });

  it("throws when OPENCLAW_CONFIG_PATH is relative", () => {
    withEnv({ OPENCLAW_CONFIG_PATH: "./config.json" }, () => {
      expect(() => parseWorkerModeEnv()).toThrow("OPENCLAW_CONFIG_PATH");
    });
  });

  it("throws when OPENCLAW_CONFIG_PATH contains traversal (..)", () => {
    withEnv({ OPENCLAW_CONFIG_PATH: "/home/user/../etc/passwd" }, () => {
      expect(() => parseWorkerModeEnv()).toThrow("OPENCLAW_CONFIG_PATH");
    });
  });
});

// ---------------------------------------------------------------------------
// registerWorkerFactory / getRegisteredWorkerFactory / runWorkerMode
// ---------------------------------------------------------------------------
describe("worker factory registry", () => {
  const MOCK_ENV: WorkerModeEnv = {
    teamName: "t",
    memberName: "m",
    role: "r",
    configPath: "/tmp/config.json",
    notifyPort: 9100,
  };

  it("getRegisteredWorkerFactory returns null when no factory registered", () => {
    expect(getRegisteredWorkerFactory()).toBeNull();
  });

  it("runWorkerMode throws when no factory is registered", async () => {
    await expect(runWorkerMode(MOCK_ENV)).rejects.toThrow(
      "--mode=worker: no worker factory registered",
    );
  });

  it("calls the registered factory with the correct env", async () => {
    const factory = vi.fn().mockResolvedValue(undefined);
    registerWorkerFactory(factory);
    await runWorkerMode(MOCK_ENV);
    expect(factory).toHaveBeenCalledWith(MOCK_ENV);
  });

  it("second registerWorkerFactory call replaces the first", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    registerWorkerFactory(first);
    registerWorkerFactory(second);
    await runWorkerMode(MOCK_ENV);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(MOCK_ENV);
  });

  it("registerWorkerFactory(null) unregisters the factory", () => {
    const factory = vi.fn();
    registerWorkerFactory(factory);
    registerWorkerFactory(null);
    expect(getRegisteredWorkerFactory()).toBeNull();
  });

  it("getRegisteredWorkerFactory returns the registered factory", () => {
    const factory = vi.fn();
    registerWorkerFactory(factory);
    expect(getRegisteredWorkerFactory()).toBe(factory);
  });
});
