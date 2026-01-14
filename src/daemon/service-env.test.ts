import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMinimalServicePath, buildServiceEnvironment } from "./service-env.js";

describe("buildMinimalServicePath", () => {
  it("includes Homebrew + system dirs on macOS", () => {
    const result = buildMinimalServicePath({
      platform: "darwin",
    });
    const parts = result.split(path.delimiter);
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/local/bin");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
  });

  it("returns PATH as-is on Windows", () => {
    const result = buildMinimalServicePath({
      env: { PATH: "C:\\\\Windows\\\\System32" },
      platform: "win32",
    });
    expect(result).toBe("C:\\\\Windows\\\\System32");
  });

  it("includes extra directories when provided", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      extraDirs: ["/custom/tools"],
    });
    expect(result.split(path.delimiter)).toContain("/custom/tools");
  });

  it("deduplicates directories", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      extraDirs: ["/usr/bin"],
    });
    const parts = result.split(path.delimiter);
    const unique = [...new Set(parts)];
    expect(parts.length).toBe(unique.length);
  });
});

describe("buildServiceEnvironment", () => {
  it("sets minimal PATH and gateway vars", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      token: "secret",
    });
    if (process.platform === "win32") {
      expect(env.PATH).toBe("");
    } else {
      expect(env.PATH).toContain("/usr/bin");
    }
    expect(env.CLAWDBOT_GATEWAY_PORT).toBe("18789");
    expect(env.CLAWDBOT_GATEWAY_TOKEN).toBe("secret");
    expect(env.CLAWDBOT_SERVICE_MARKER).toBe("clawdbot");
    expect(env.CLAWDBOT_SERVICE_KIND).toBe("gateway");
    expect(typeof env.CLAWDBOT_SERVICE_VERSION).toBe("string");
    expect(env.CLAWDBOT_SYSTEMD_UNIT).toBe("clawdbot-gateway.service");
    if (process.platform === "darwin") {
      expect(env.CLAWDBOT_LAUNCHD_LABEL).toBe("com.clawdbot.gateway");
    }
  });

  it("uses profile-specific unit and label", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", CLAWDBOT_PROFILE: "work" },
      port: 18789,
    });
    expect(env.CLAWDBOT_SYSTEMD_UNIT).toBe("clawdbot-gateway-work.service");
    if (process.platform === "darwin") {
      expect(env.CLAWDBOT_LAUNCHD_LABEL).toBe("com.clawdbot.work");
    }
  });
});
