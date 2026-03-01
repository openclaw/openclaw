import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayStateDir } from "./paths.js";
import {
  buildMinimalServicePath,
  buildNodeServiceEnvironment,
  buildServiceEnvironment,
  getMinimalServicePathParts,
  getMinimalServicePathPartsFromEnv,
} from "./service-env.js";

describe("getMinimalServicePathParts - Linux user directories", () => {
  it("includes user bin directories when HOME is set on Linux", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: "/home/testuser",
    });

    // Should include all common user bin directories
    expect(result).toContain("/home/testuser/.local/bin");
    expect(result).toContain("/home/testuser/.npm-global/bin");
    expect(result).toContain("/home/testuser/bin");
    expect(result).toContain("/home/testuser/.nvm/current/bin");
    expect(result).toContain("/home/testuser/.fnm/current/bin");
    expect(result).toContain("/home/testuser/.volta/bin");
    expect(result).toContain("/home/testuser/.asdf/shims");
    expect(result).toContain("/home/testuser/.local/share/pnpm");
    expect(result).toContain("/home/testuser/.bun/bin");
  });

  it("excludes user bin directories when HOME is undefined on Linux", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: undefined,
    });

    // Should only include system directories
    expect(result).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);

    // Should not include any user-specific paths
    expect(result.some((p) => p.includes(".local"))).toBe(false);
    expect(result.some((p) => p.includes(".npm-global"))).toBe(false);
    expect(result.some((p) => p.includes(".nvm"))).toBe(false);
  });

  it("places user directories before system directories on Linux", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: "/home/testuser",
    });

    const userDirIndex = result.indexOf("/home/testuser/.local/bin");
    const systemDirIndex = result.indexOf("/usr/bin");

    expect(userDirIndex).toBeGreaterThan(-1);
    expect(systemDirIndex).toBeGreaterThan(-1);
    expect(userDirIndex).toBeLessThan(systemDirIndex);
  });

  it("places extraDirs before user directories on Linux", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: "/home/testuser",
      extraDirs: ["/custom/bin"],
    });

    const extraDirIndex = result.indexOf("/custom/bin");
    const userDirIndex = result.indexOf("/home/testuser/.local/bin");

    expect(extraDirIndex).toBeGreaterThan(-1);
    expect(userDirIndex).toBeGreaterThan(-1);
    expect(extraDirIndex).toBeLessThan(userDirIndex);
  });

  it("includes env-configured bin roots when HOME is set on Linux", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      env: {
        HOME: "/home/testuser",
        PNPM_HOME: "/opt/pnpm",
        NPM_CONFIG_PREFIX: "/opt/npm",
        BUN_INSTALL: "/opt/bun",
        VOLTA_HOME: "/opt/volta",
        ASDF_DATA_DIR: "/opt/asdf",
        NVM_DIR: "/opt/nvm",
        FNM_DIR: "/opt/fnm",
      },
    });

    expect(result).toContain("/opt/pnpm");
    expect(result).toContain("/opt/npm/bin");
    expect(result).toContain("/opt/bun/bin");
    expect(result).toContain("/opt/volta/bin");
    expect(result).toContain("/opt/asdf/shims");
    expect(result).toContain("/opt/nvm/current/bin");
    expect(result).toContain("/opt/fnm/current/bin");
  });

  it("includes version manager directories on macOS when HOME is set", () => {
    const result = getMinimalServicePathParts({
      platform: "darwin",
      home: "/Users/testuser",
    });

    // Should include common user bin directories
    expect(result).toContain("/Users/testuser/.local/bin");
    expect(result).toContain("/Users/testuser/.npm-global/bin");
    expect(result).toContain("/Users/testuser/bin");

    // Should include version manager paths (macOS specific)
    // Note: nvm has no stable default path, relies on user's shell config
    expect(result).toContain("/Users/testuser/Library/Application Support/fnm/aliases/default/bin"); // fnm default on macOS
    expect(result).toContain("/Users/testuser/.fnm/aliases/default/bin"); // fnm if customized to ~/.fnm
    expect(result).toContain("/Users/testuser/.volta/bin");
    expect(result).toContain("/Users/testuser/.asdf/shims");
    expect(result).toContain("/Users/testuser/Library/pnpm"); // pnpm default on macOS
    expect(result).toContain("/Users/testuser/.local/share/pnpm"); // pnpm XDG fallback
    expect(result).toContain("/Users/testuser/.bun/bin");

    // Should also include macOS system directories
    expect(result).toContain("/opt/homebrew/bin");
    expect(result).toContain("/usr/local/bin");
  });

  it("includes env-configured version manager dirs on macOS", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "darwin",
      env: {
        HOME: "/Users/testuser",
        FNM_DIR: "/Users/testuser/Library/Application Support/fnm",
        NVM_DIR: "/Users/testuser/.nvm",
        PNPM_HOME: "/Users/testuser/Library/pnpm",
      },
    });

    // fnm uses aliases/default/bin (not current)
    expect(result).toContain("/Users/testuser/Library/Application Support/fnm/aliases/default/bin");
    // nvm: relies on NVM_DIR env var (no stable default path)
    expect(result).toContain("/Users/testuser/.nvm");
    // pnpm: binary is directly in PNPM_HOME
    expect(result).toContain("/Users/testuser/Library/pnpm");
  });

  it("places version manager dirs before system dirs on macOS", () => {
    const result = getMinimalServicePathParts({
      platform: "darwin",
      home: "/Users/testuser",
    });

    // fnm on macOS defaults to ~/Library/Application Support/fnm
    const fnmIndex = result.indexOf(
      "/Users/testuser/Library/Application Support/fnm/aliases/default/bin",
    );
    const homebrewIndex = result.indexOf("/opt/homebrew/bin");

    expect(fnmIndex).toBeGreaterThan(-1);
    expect(homebrewIndex).toBeGreaterThan(-1);
    expect(fnmIndex).toBeLessThan(homebrewIndex);
  });

  it("does not include Linux user directories on Windows", () => {
    const result = getMinimalServicePathParts({
      platform: "win32",
      home: "C:\\Users\\testuser",
    });

    // Windows returns empty array (uses existing PATH)
    expect(result).toEqual([]);
  });
});

describe("buildMinimalServicePath", () => {
  const splitPath = (value: string, platform: NodeJS.Platform) =>
    value.split(platform === "win32" ? path.win32.delimiter : path.posix.delimiter);

  it("includes Homebrew + system dirs on macOS", () => {
    const result = buildMinimalServicePath({
      platform: "darwin",
    });
    const parts = splitPath(result, "darwin");
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

  it("includes Linux user directories when HOME is set in env", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      env: { HOME: "/home/alice" },
    });
    const parts = splitPath(result, "linux");

    // Verify user directories are included
    expect(parts).toContain("/home/alice/.local/bin");
    expect(parts).toContain("/home/alice/.npm-global/bin");
    expect(parts).toContain("/home/alice/.nvm/current/bin");

    // Verify system directories are also included
    expect(parts).toContain("/usr/local/bin");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
  });

  it("excludes Linux user directories when HOME is not in env", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      env: {},
    });
    const parts = splitPath(result, "linux");

    // Should only have system directories
    expect(parts).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);

    // No user-specific paths
    expect(parts.some((p) => p.includes("home"))).toBe(false);
  });

  it("ensures user directories come before system directories on Linux", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      env: { HOME: "/home/bob" },
    });
    const parts = splitPath(result, "linux");

    const firstUserDirIdx = parts.indexOf("/home/bob/.local/bin");
    const firstSystemDirIdx = parts.indexOf("/usr/local/bin");

    expect(firstUserDirIdx).toBeLessThan(firstSystemDirIdx);
  });

  it("includes extra directories when provided", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      extraDirs: ["/custom/tools"],
      env: {},
    });
    expect(splitPath(result, "linux")).toContain("/custom/tools");
  });

  it("deduplicates directories", () => {
    const result = buildMinimalServicePath({
      platform: "linux",
      extraDirs: ["/usr/bin"],
      env: {},
    });
    const parts = splitPath(result, "linux");
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
    expect(env.HOME).toBe("/home/user");
    if (process.platform === "win32") {
      expect(env.PATH).toBe("");
    } else {
      expect(env.PATH).toContain("/usr/bin");
    }
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("18789");
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("secret");
    expect(env.OPENCLAW_SERVICE_MARKER).toBe("openclaw");
    expect(env.OPENCLAW_SERVICE_KIND).toBe("gateway");
    expect(typeof env.OPENCLAW_SERVICE_VERSION).toBe("string");
    expect(env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway.service");
    if (process.platform === "darwin") {
      expect(env.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.gateway");
    }
  });

  it("forwards TMPDIR from the host environment", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", TMPDIR: "/var/folders/xw/abc123/T/" },
      port: 18789,
    });
    expect(env.TMPDIR).toBe("/var/folders/xw/abc123/T/");
  });

  it("falls back to os.tmpdir when TMPDIR is not set", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
    });
    expect(env.TMPDIR).toBe(os.tmpdir());
  });

  it("uses profile-specific unit and label", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", OPENCLAW_PROFILE: "work" },
      port: 18789,
    });
    expect(env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway-work.service");
    if (process.platform === "darwin") {
      expect(env.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.work");
    }
  });

  it("forwards proxy environment variables for launchd/systemd runtime", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "/home/user",
        HTTP_PROXY: " http://proxy.local:7890 ",
        HTTPS_PROXY: "https://proxy.local:7890",
        NO_PROXY: "localhost,127.0.0.1",
        http_proxy: "http://proxy.local:7890",
        all_proxy: "socks5://proxy.local:1080",
      },
      port: 18789,
    });

    expect(env.HTTP_PROXY).toBe("http://proxy.local:7890");
    expect(env.HTTPS_PROXY).toBe("https://proxy.local:7890");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.http_proxy).toBe("http://proxy.local:7890");
    expect(env.all_proxy).toBe("socks5://proxy.local:1080");
  });
  it("defaults NODE_EXTRA_CA_CERTS to system cert bundle on macOS", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      platform: "darwin",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/cert.pem");
  });

  it("does not default NODE_EXTRA_CA_CERTS on non-macOS", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      platform: "linux",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("respects user-provided NODE_EXTRA_CA_CERTS over the default", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", NODE_EXTRA_CA_CERTS: "/custom/certs/ca.pem" },
      port: 18789,
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/custom/certs/ca.pem");
  });
});

describe("buildNodeServiceEnvironment", () => {
  it("passes through HOME for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user" },
    });
    expect(env.HOME).toBe("/home/user");
  });

  it("forwards proxy environment variables for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: {
        HOME: "/home/user",
        HTTPS_PROXY: " https://proxy.local:7890 ",
        no_proxy: "localhost,127.0.0.1",
      },
    });

    expect(env.HTTPS_PROXY).toBe("https://proxy.local:7890");
    expect(env.no_proxy).toBe("localhost,127.0.0.1");
  });

  it("forwards TMPDIR for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user", TMPDIR: "/tmp/custom" },
    });
    expect(env.TMPDIR).toBe("/tmp/custom");
  });

  it("falls back to os.tmpdir for node services when TMPDIR is not set", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user" },
    });
    expect(env.TMPDIR).toBe(os.tmpdir());
  });

  it("defaults NODE_EXTRA_CA_CERTS to system cert bundle on macOS for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user" },
      platform: "darwin",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/cert.pem");
  });

  it("does not default NODE_EXTRA_CA_CERTS on non-macOS for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user" },
      platform: "linux",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("respects user-provided NODE_EXTRA_CA_CERTS for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user", NODE_EXTRA_CA_CERTS: "/custom/certs/ca.pem" },
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/custom/certs/ca.pem");
  });
});

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".openclaw"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", OPENCLAW_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".openclaw-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", OPENCLAW_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".openclaw"));
  });

  it("uses OPENCLAW_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", OPENCLAW_STATE_DIR: "/var/lib/openclaw" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/openclaw"));
  });

  it("expands ~ in OPENCLAW_STATE_DIR", () => {
    const env = { HOME: "/Users/test", OPENCLAW_STATE_DIR: "~/openclaw-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/openclaw-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { OPENCLAW_STATE_DIR: "C:\\State\\openclaw" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\openclaw");
  });
});
