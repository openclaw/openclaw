// Daemon service env tests cover environment variable assembly for services.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveAutoNodeExtraCaCerts } from "../bootstrap/node-extra-ca-certs.js";
import { resolveIsConfigReadOnly, resolveIsNixMode } from "../config/paths.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { resolveGatewayStateDir } from "./paths.js";
import {
  buildNodeServiceEnvironment,
  buildServiceEnvironment,
  getMinimalServicePathPartsFromEnv,
} from "./service-env.js";

type ServicePathOptions = NonNullable<Parameters<typeof getMinimalServicePathPartsFromEnv>[0]>;

function getMinimalServicePathParts(options: ServicePathOptions = {}): string[] {
  return getMinimalServicePathPartsFromEnv({ env: {}, ...options });
}

describe("getMinimalServicePathParts - Linux user directories", () => {
  const allExist = (): boolean => true;
  const noneExist = (): boolean => false;

  it("includes user bin directories when HOME is set on Linux", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: "/home/testuser",
      existsSync: allExist,
    });

    // Should include all common user bin directories
    expect(result).toContain("/home/testuser/.local/bin");
    expect(result).toContain("/home/testuser/.npm-global/bin");
    expect(result).toContain("/home/testuser/bin");
    expect(result).toContain("/home/testuser/.nvm/current/bin");
    expect(result).toContain("/home/testuser/.local/share/fnm/aliases/default/bin");
    expect(result).toContain("/home/testuser/.local/share/fnm/current/bin");
    expect(result).toContain("/home/testuser/.fnm/aliases/default/bin");
    expect(result).toContain("/home/testuser/.fnm/current/bin");
    expect(result).toContain("/home/testuser/.volta/bin");
    expect(result).toContain("/home/testuser/.asdf/shims");
    expect(result).toContain("/home/testuser/.local/share/pnpm/bin");
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
  });

  it("places package-manager bin directories after trusted system directories on Linux", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      env: {
        HOME: "/home/testuser",
        PNPM_HOME: "/home/testuser/.local/share/pnpm",
        NPM_CONFIG_PREFIX: "/home/testuser/.npm-global",
      },
      existsSync: allExist,
    });

    const systemDirIndex = result.indexOf("/usr/bin");
    const packageManagerDirs = [
      "/home/testuser/.local/share/pnpm",
      "/home/testuser/.local/share/pnpm/bin",
      "/home/testuser/.npm-global/bin",
    ];

    expect(systemDirIndex).toBeGreaterThan(-1);
    for (const dir of packageManagerDirs) {
      const dirIndex = result.indexOf(dir);
      expect(dirIndex).toBeGreaterThan(-1);
      expect(systemDirIndex).toBeLessThan(dirIndex);
    }
  });

  it("can include env-configured version manager dirs on macOS when requested", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "darwin",
      includeUserDirs: true,
      env: {
        HOME: "/Users/testuser",
        FNM_DIR: "/Users/testuser/Library/Application Support/fnm",
        NVM_DIR: "/Users/testuser/.nvm",
        PNPM_HOME: "/Users/testuser/Library/pnpm",
      },
      existsSync: allExist,
    });

    // fnm uses aliases/default/bin (not current)
    expect(result).toContain("/Users/testuser/Library/Application Support/fnm/aliases/default/bin");
    // nvm: relies on NVM_DIR env var (no stable default path)
    expect(result).toContain("/Users/testuser/.nvm");
    // pnpm: binary is directly in PNPM_HOME
    expect(result).toContain("/Users/testuser/Library/pnpm");
  });

  it("does not include Linux user directories on Windows", () => {
    const result = getMinimalServicePathParts({
      platform: "win32",
      home: "C:\\Users\\testuser",
      existsSync: allExist,
    });

    // Windows returns empty array (uses existing PATH)
    expect(result).toStrictEqual([]);
  });

  it("omits hard-coded version-manager fallbacks on Linux when missing", () => {
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: "/home/testuser",
      existsSync: noneExist,
    });

    expect(result).toContain("/home/testuser/.local/bin");
    expect(result).toContain("/home/testuser/.npm-global/bin");
    expect(result).toContain("/home/testuser/bin");
    expect(result).toContain("/home/testuser/.nix-profile/bin");
    expect(result).not.toContain("/home/testuser/.volta/bin");
    expect(result).not.toContain("/home/testuser/.asdf/shims");
    expect(result).not.toContain("/home/testuser/.bun/bin");
    expect(result).not.toContain("/home/testuser/.nvm/current/bin");
    expect(result).not.toContain("/home/testuser/.local/share/fnm/aliases/default/bin");
    expect(result).not.toContain("/home/testuser/.local/share/fnm/current/bin");
    expect(result).not.toContain("/home/testuser/.fnm/aliases/default/bin");
    expect(result).not.toContain("/home/testuser/.fnm/current/bin");
    expect(result).not.toContain("/home/testuser/.local/share/pnpm");
  });

  it("can omit missing stable user-bin defaults for service PATH audits", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      env: { HOME: "/home/testuser" },
      existsSync: (candidate) => candidate === "/home/testuser/.local/bin",
      includeMissingUserBinDefaults: false,
    });

    expect(result).toContain("/home/testuser/.local/bin");
    expect(result).not.toContain("/home/testuser/.npm-global/bin");
    expect(result).not.toContain("/home/testuser/bin");
    expect(result).not.toContain("/home/testuser/.nix-profile/bin");
  });

  it("keeps env-configured roots when fallback directories are missing", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      env: {
        HOME: "/home/testuser",
        PNPM_HOME: "/opt/pnpm",
        VOLTA_HOME: "/opt/volta",
        BUN_INSTALL: "/opt/bun",
        ASDF_DATA_DIR: "/opt/asdf",
        NVM_DIR: "/opt/nvm",
        FNM_DIR: "/opt/fnm",
      },
      existsSync: noneExist,
    });

    expect(result).toContain("/opt/pnpm");
    expect(result).toContain("/opt/pnpm/bin");
    expect(result).toContain("/opt/volta/bin");
    expect(result).toContain("/opt/bun/bin");
    expect(result).toContain("/opt/asdf/shims");
    expect(result).toContain("/opt/nvm/current/bin");
    expect(result).toContain("/opt/fnm/aliases/default/bin");
    expect(result).toContain("/opt/fnm/current/bin");
  });

  it("excludes env-configured bin roots derived from the install workspace", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      cwd: "/home/testuser/workspace",
      env: {
        HOME: "/home/testuser",
        PNPM_HOME: "/home/testuser/workspace/evil-pnpm-home",
        NPM_CONFIG_PREFIX: "/proc/thread-self/cwd/evil-npm-prefix",
        BUN_INSTALL: "/proc/12345/cwd/evil-bun",
        VOLTA_HOME: "/opt/volta",
        ASDF_DATA_DIR: "relative-asdf",
        NIX_PROFILES: "/nix/var/nix/profiles/default /home/testuser/workspace/evil-nix-profile",
      },
      existsSync: noneExist,
    });

    expect(result).not.toContain("/home/testuser/workspace/evil-pnpm-home");
    expect(result).not.toContain("/proc/thread-self/cwd/evil-npm-prefix/bin");
    expect(result).not.toContain("/proc/12345/cwd/evil-bun/bin");
    expect(result).not.toContain("relative-asdf/shims");
    expect(result).not.toContain("/home/testuser/workspace/evil-nix-profile/bin");
    expect(result).toContain("/opt/volta/bin");
    expect(result).toContain("/nix/var/nix/profiles/default/bin");
  });

  it("excludes env-configured bin roots whose existing parent resolves into the workspace", () => {
    const realpathNative = vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => {
      const value = String(candidate);
      if (value === "/tmp/workspace-link") {
        return "/home/testuser/workspace";
      }
      if (value === "/home/testuser/workspace" || value === "/home/testuser") {
        return value;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    try {
      const result = getMinimalServicePathPartsFromEnv({
        platform: "linux",
        cwd: "/home/testuser/workspace",
        env: {
          HOME: "/home/testuser",
          PNPM_HOME: "/tmp/workspace-link/missing-pnpm-home",
          VOLTA_HOME: "/opt/volta",
        },
        existsSync: noneExist,
      });

      expect(result).not.toContain("/tmp/workspace-link/missing-pnpm-home");
      expect(result).toContain("/opt/volta/bin");
    } finally {
      realpathNative.mockRestore();
    }
  });

  it("keeps env-configured user toolchain roots when the install cwd is HOME", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      cwd: "/home/testuser",
      env: {
        HOME: "/home/testuser",
        PNPM_HOME: "/home/testuser/.local/share/pnpm",
        FNM_DIR: "/home/testuser/.local/share/fnm",
      },
      existsSync: noneExist,
    });

    expect(result).toContain("/home/testuser/.local/share/pnpm");
    expect(result).toContain("/home/testuser/.local/share/pnpm/bin");
    expect(result).toContain("/home/testuser/.local/share/fnm/aliases/default/bin");
    expect(result).toContain("/home/testuser/.local/share/fnm/current/bin");
  });

  it("emits only existing hard-coded version-manager fallbacks", () => {
    const exists = (candidate: string) =>
      candidate === "/home/testuser/.volta/bin" ||
      candidate === "/home/testuser/.local/share/fnm/aliases/default/bin";
    const result = getMinimalServicePathParts({
      platform: "linux",
      home: "/home/testuser",
      existsSync: exists,
    });

    expect(result).toContain("/home/testuser/.volta/bin");
    expect(result).toContain("/home/testuser/.local/share/fnm/aliases/default/bin");
    expect(result).not.toContain("/home/testuser/.bun/bin");
    expect(result).not.toContain("/home/testuser/.asdf/shims");
    expect(result).not.toContain("/home/testuser/.fnm/aliases/default/bin");
  });
});

describe("getMinimalServicePathParts - Nix Home Manager", () => {
  it("can include single Nix profile from NIX_PROFILES on macOS when requested", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "darwin",
      includeUserDirs: true,
      env: {
        HOME: "/Users/testuser",
        NIX_PROFILES: "/nix/var/nix/profiles/per-user/testuser/profile",
      },
      existsSync: () => true,
    });

    expect(result).toContain("/nix/var/nix/profiles/per-user/testuser/profile/bin");
  });

  it("preserves Nix precedence across three profiles", () => {
    const result = getMinimalServicePathPartsFromEnv({
      platform: "linux",
      env: {
        HOME: "/home/testuser",
        NIX_PROFILES:
          "/nix/var/nix/profiles/default /nix/var/nix/profiles/per-user/testuser/custom /home/testuser/.nix-profile",
      },
      existsSync: () => true,
    });

    const userIdx = result.indexOf("/home/testuser/.nix-profile/bin");
    const customIdx = result.indexOf("/nix/var/nix/profiles/per-user/testuser/custom/bin");
    const defaultIdx = result.indexOf("/nix/var/nix/profiles/default/bin");
    expect(userIdx).toBeGreaterThan(-1);
    expect(customIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(customIdx);
    expect(customIdx).toBeLessThan(defaultIdx);
  });
});

describe("buildServiceEnvironment", () => {
  it("preserves config write protection without enabling Nix mode", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", OPENCLAW_CONFIG_READONLY: "1" },
      port: 18789,
      platform: "linux",
    });
    expect(resolveIsConfigReadOnly(env)).toBe(true);
    expect(resolveIsNixMode(env)).toBe(false);
  });

  it("sets minimal PATH and gateway vars", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      platform: "darwin",
    });
    expect(env.HOME).toBe("/home/user");
    expect(env.PATH).toContain("/usr/bin");
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("18789");
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.OPENCLAW_SERVICE_MARKER).toBe("openclaw");
    expect(env.OPENCLAW_SERVICE_KIND).toBe("gateway");
    expect(env).not.toHaveProperty("OPENCLAW_SERVICE_VERSION");
    expect(env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway.service");
    expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Gateway");
    expect(env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBe("1");
    expect(env.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.gateway");
  });

  it("passes through OPENCLAW_WRAPPER for gateway services", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "/home/user",
        OPENCLAW_WRAPPER: " /usr/local/bin/openclaw-doppler ",
      },
      port: 18789,
    });

    expect(env.OPENCLAW_WRAPPER).toBe("/usr/local/bin/openclaw-doppler");
  });

  it("forwards TMPDIR from the host environment on Linux", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", TMPDIR: "/var/folders/xw/abc123/T/" },
      port: 18789,
      platform: "linux",
    });
    expect(env.TMPDIR).toBe("/var/folders/xw/abc123/T/");
  });

  it("uses a durable state temp directory for macOS LaunchAgents", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/Users/user", TMPDIR: "/var/folders/xw/abc123/T/" },
      port: 18789,
      platform: "darwin",
    });
    expect(env.TMPDIR).toBe(path.join("/Users/user", ".openclaw", "tmp"));
  });

  it("uses a canonical system PATH for macOS LaunchAgents", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "/Users/user",
        FNM_DIR: "/Users/user/Library/Application Support/fnm",
        PNPM_HOME: "/Users/user/Library/pnpm",
        VOLTA_HOME: "/Users/user/.volta",
        ASDF_DATA_DIR: "/Users/user/.asdf",
        NIX_PROFILES: "/nix/var/nix/profiles/default /Users/user/.nix-profile",
      },
      port: 18789,
      platform: "darwin",
    });

    expect(env.PATH).toBe(
      "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });

  it("falls back to os.tmpdir when TMPDIR is not set on Linux", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      platform: "linux",
    });
    expect(env.TMPDIR).toBe(os.tmpdir());
  });

  it("uses profile-specific unit and label", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user", OPENCLAW_PROFILE: "work" },
      port: 18789,
      platform: "darwin",
    });
    expect(env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway-work.service");
    expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Gateway (work)");
    expect(env.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.work");
  });

  it("preserves explicit systemd unit overrides", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "/home/user",
        OPENCLAW_PROFILE: "work",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-maintenance",
      },
      port: 18789,
      platform: "linux",
    });

    expect(env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway-maintenance.service");
  });

  it("preserves explicit systemd unit overrides with service suffix", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "/home/user",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-maintenance.service",
      },
      port: 18789,
      platform: "linux",
    });

    expect(env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway-maintenance.service");
  });

  it("does not persist ambient proxy environment variables for launchd/systemd runtime", () => {
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

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.all_proxy).toBeUndefined();
  });

  it("forwards proxy URL env fallback for installed gateway services", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "/home/user",
        OPENCLAW_PROXY_URL: " http://127.0.0.1:3128 ",
      },
      port: 18789,
    });

    expect(env.OPENCLAW_PROXY_URL).toBe("http://127.0.0.1:3128");
  });

  it("omits PATH on Windows so Scheduled Tasks can inherit the current shell path", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "C:\\Users\\alice",
        PATH: "C:\\Windows\\System32;C:\\Tools\\rg",
      },
      port: 18789,
      platform: "win32",
    });

    expect(env).not.toHaveProperty("PATH");
    expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Gateway");
  });

  it("prepends extra runtime directories to the gateway service PATH", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      platform: "linux",
      extraPathDirs: ["/home/user/.nvm/versions/node/v22.22.0/bin"],
    });

    expect(env.PATH?.split(path.posix.delimiter)[0]).toBe(
      "/home/user/.nvm/versions/node/v22.22.0/bin",
    );
  });

  it("prepends explicit runtime directories to macOS LaunchAgent PATH", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/Users/user", VOLTA_HOME: "/Users/user/.volta" },
      port: 18789,
      platform: "darwin",
      extraPathDirs: ["/opt/homebrew/Cellar/node/22.19.0/bin"],
    });

    expect(env.PATH).toBe(
      "/opt/homebrew/Cellar/node/22.19.0/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });
});

describe("buildServiceEnvironment NODE_OPTIONS", () => {
  it.each([
    { capacityMiB: 65536, wrapper: undefined, expected: "--max-old-space-size=8192" },
    { capacityMiB: 2048, wrapper: undefined, expected: "--max-old-space-size=1536" },
    { capacityMiB: 65536, wrapper: "/custom/launcher", expected: "" },
  ])(
    "retains only direct Bun's prior budget at $capacityMiB MiB (wrapper=$wrapper)",
    ({ capacityMiB, wrapper, expected }) => {
      const physical = vi.spyOn(os, "totalmem").mockReturnValue(capacityMiB * 1024 ** 2);
      const constrained = vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
      try {
        expect(
          buildServiceEnvironment({
            env: { HOME: "/home/user", OPENCLAW_WRAPPER: wrapper },
            port: 18789,
            runtime: "bun",
          }).NODE_OPTIONS,
        ).toBe(expected);
      } finally {
        physical.mockRestore();
        constrained.mockRestore();
      }
    },
  );

  it("drops ambient NODE_OPTIONS", () => {
    const env = buildServiceEnvironment({
      env: {
        HOME: "/home/user",
        NODE_OPTIONS: "--require /tmp/preload.js --max-old-space-size=16384",
      },
      port: 18789,
    });
    expect(env.NODE_OPTIONS).toBe("");
  });

  it("keeps an explicit heap flag from the existing service only", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      existingNodeOptions: "--require /tmp/preload.js --max_old_space_size=6144",
    });
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=6144");
  });

  it("does not apply the Gateway heap policy to node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user" },
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});

describe("buildNodeServiceEnvironment", () => {
  it("sets the OpenClaw-owned launchd marker for macOS node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/Users/user" },
      platform: "darwin",
    });

    expect(env.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.node");
  });

  it("fences inherited Node compile cache in macOS node LaunchAgents", () => {
    const environment = buildNodeServiceEnvironment({
      env: {
        HOME: "/Users/user",
        NODE_COMPILE_CACHE: "/tmp/ambient-node-compile-cache",
      },
      platform: "darwin",
    });
    const plist = buildLaunchAgentPlist({
      label: "ai.openclaw.node",
      programArguments: ["/usr/local/bin/node", "dist/index.js", "node", "run"],
      stdoutPath: "/tmp/openclaw-node.log",
      stderrPath: "/tmp/openclaw-node.err.log",
      environment,
    });

    expect(environment.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(environment.NODE_COMPILE_CACHE).toBeUndefined();
    expect(plist).toContain("<key>NODE_DISABLE_COMPILE_CACHE</key>");
    expect(plist).not.toContain("<key>NODE_COMPILE_CACHE</key>");
  });

  it.each(["linux", "win32"] as const)(
    "does not force Node compile cache off for %s node services",
    (platform) => {
      const environment = buildNodeServiceEnvironment({
        env: {
          HOME: platform === "win32" ? "C:\\Users\\user" : "/home/user",
          NODE_COMPILE_CACHE: "/tmp/ambient-node-compile-cache",
        },
        platform,
      });

      expect(environment.NODE_DISABLE_COMPILE_CACHE).toBeUndefined();
      expect(environment.NODE_COMPILE_CACHE).toBeUndefined();
    },
  );

  it("passes through OPENCLAW_GATEWAY_TOKEN for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user", OPENCLAW_GATEWAY_TOKEN: " node-token " },
    });
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("node-token");
  });

  it("passes through OPENCLAW_GATEWAY_PASSWORD for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user", OPENCLAW_GATEWAY_PASSWORD: " node-password " },
    });
    expect(env.OPENCLAW_GATEWAY_PASSWORD).toBe("node-password");
  });

  it("passes through the Cloudflare Access service-token pair for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: {
        HOME: "/home/user",
        CF_ACCESS_CLIENT_ID: " cf-client-id ",
        CF_ACCESS_CLIENT_SECRET: " cf-client-secret ",
      },
    });
    expect(env.CF_ACCESS_CLIENT_ID).toBe("cf-client-id");
    expect(env.CF_ACCESS_CLIENT_SECRET).toBe("cf-client-secret");
  });

  it("passes through OPENCLAW_ALLOW_INSECURE_PRIVATE_WS for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/home/user", OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: " 1 " },
    });
    expect(env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS).toBe("1");
  });

  it("omits OPENCLAW_GATEWAY_TOKEN when the env var is empty", () => {
    const env = buildNodeServiceEnvironment({
      env: {
        HOME: "/home/user",
        OPENCLAW_GATEWAY_TOKEN: "   ",
      },
    });
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });

  it("marks Windows node tasks for hidden launcher startup", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "C:\\Users\\alice" },
      platform: "win32",
    });

    expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Node");
    expect(env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBe("1");
    expect(env.OPENCLAW_TASK_SCRIPT_NAME).toBe("node.cmd");
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

  it("does not interpret $ patterns in HOME when expanding ~ in OPENCLAW_STATE_DIR", () => {
    const env = { HOME: "/home/$&user", OPENCLAW_STATE_DIR: "~/openclaw-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/home/$&user/openclaw-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { OPENCLAW_STATE_DIR: "C:\\State\\openclaw" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\openclaw");
  });
});

describe("shared Node TLS env defaults focused", () => {
  it("sets macOS TLS defaults for gateway services", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/Users/test" },
      port: 18789,
      platform: "darwin",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/cert.pem");
    expect(env.NODE_USE_SYSTEM_CA).toBe("1");
  });

  it("sets macOS TLS defaults for node services", () => {
    const env = buildNodeServiceEnvironment({
      env: { HOME: "/Users/test" },
      platform: "darwin",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/cert.pem");
    expect(env.NODE_USE_SYSTEM_CA).toBe("1");
  });

  it("defaults NODE_EXTRA_CA_CERTS on Linux when NVM_DIR is set", () => {
    const sourceEnv = { HOME: "/home/user", NVM_DIR: "/home/user/.nvm" };
    const expected = resolveAutoNodeExtraCaCerts({
      env: sourceEnv,
      platform: "linux",
      execPath: "/usr/bin/node",
    });
    const env = buildServiceEnvironment({
      env: sourceEnv,
      port: 18789,
      platform: "linux",
      execPath: "/usr/bin/node",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe(expected);
  });

  it("defaults NODE_EXTRA_CA_CERTS on Linux when execPath is under nvm", () => {
    const sourceEnv = { HOME: "/home/user" };
    const execPath = "/home/user/.nvm/versions/node/v22.22.0/bin/node";
    const expected = resolveAutoNodeExtraCaCerts({
      env: sourceEnv,
      platform: "linux",
      execPath,
    });
    const env = buildNodeServiceEnvironment({
      env: sourceEnv,
      platform: "linux",
      execPath,
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe(expected);
  });

  it("does not default NODE_EXTRA_CA_CERTS on Linux without nvm", () => {
    const env = buildServiceEnvironment({
      env: { HOME: "/home/user" },
      port: 18789,
      platform: "linux",
      execPath: "/usr/bin/node",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("respects user-provided NODE_EXTRA_CA_CERTS on Linux with nvm", () => {
    const env = buildNodeServiceEnvironment({
      env: {
        HOME: "/home/user",
        NVM_DIR: "/home/user/.nvm",
        NODE_EXTRA_CA_CERTS: "/custom/ca-bundle.crt",
      },
      platform: "linux",
      execPath: "/home/user/.nvm/versions/node/v22.22.0/bin/node",
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/custom/ca-bundle.crt");
  });
});
