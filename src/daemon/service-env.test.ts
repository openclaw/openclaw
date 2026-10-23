import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveIsConfigReadOnly, resolveIsNixMode } from "../config/paths.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { resolveGatewayStateDir } from "./paths.js";
import {
  buildNodeServiceEnvironment,
  buildServiceEnvironment,
  getMinimalServicePathPartsFromEnv,
} from "./service-env.js";

type PathOptions = NonNullable<Parameters<typeof getMinimalServicePathPartsFromEnv>[0]>;
type ServiceOptions = Partial<Omit<Parameters<typeof buildServiceEnvironment>[0], "env">>;
const home = "/home/u";
const userPath = (suffix: string) => `${home}/${suffix}`;
const paths = (env: NodeJS.ProcessEnv = {}, options: PathOptions = {}) =>
  getMinimalServicePathPartsFromEnv({ platform: "linux", env: { HOME: home, ...env }, ...options });
const serviceEnv = (env: NodeJS.ProcessEnv = {}, options: ServiceOptions = {}) =>
  buildServiceEnvironment({ env: { HOME: home, ...env }, port: 18789, ...options });
afterEach(() => vi.restoreAllMocks());
function mockPaths(exists: boolean, cwd?: string) {
  vi.spyOn(fs, "existsSync").mockReturnValue(exists);
  if (cwd) {
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
  }
}

function expectPathOrder(actual: string[], expected: string[]) {
  const indices = expected.map((entry) => actual.indexOf(entry));
  for (const index of indices) {
    expect(index).toBeGreaterThan(-1);
  }
  expect(indices).toEqual(indices.toSorted((a, b) => a - b));
  expect(new Set(indices).size).toBe(indices.length);
}

describe("service PATH", () => {
  it("excludes user bins without HOME", () => {
    expect(paths({ HOME: undefined })).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);
  });
  it("uses explicit service home before the invocation home", () => {
    expect(paths({ HOME: "/home/installer" }, { home: "/home/operator" })).toContain(
      "/home/operator/.local/bin",
    );
  });
  it("places package-manager bins after trusted system directories", () => {
    mockPaths(true);
    const result = paths({
      PNPM_HOME: userPath(".local/share/pnpm"),
      NPM_CONFIG_PREFIX: userPath(".npm-global"),
    });
    for (const suffix of [".local/share/pnpm", ".local/share/pnpm/bin", ".npm-global/bin"]) {
      expectPathOrder(result, ["/usr/bin", userPath(suffix)]);
    }
  });
  it("does not include Linux user directories on Windows", () => {
    expect(paths({ HOME: "C:\\Users\\u" }, { platform: "win32" })).toStrictEqual([]);
  });
  it("can omit missing stable user-bin defaults for audits", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (candidate) => candidate === userPath(".local/bin"),
    );
    const result = paths({}, { includeMissingUserBinDefaults: false });
    expect(result).toContain(userPath(".local/bin"));
    for (const suffix of [".npm-global/bin", "bin", ".nix-profile/bin"]) {
      expect(result).not.toContain(userPath(suffix));
    }
  });
  it("excludes env-configured bins derived from the install workspace", () => {
    mockPaths(false, userPath("workspace"));
    const result = paths({
      PNPM_HOME: userPath("workspace/evil-pnpm"),
      NPM_CONFIG_PREFIX: "/proc/thread-self/cwd/evil-npm",
      BUN_INSTALL: "/proc/12345/cwd/evil-bun",
      VOLTA_HOME: "/opt/volta",
      ASDF_DATA_DIR: "relative-asdf",
      NIX_PROFILES: `/nix/default ${home}/workspace/evil-nix`,
    });
    for (const entry of [
      userPath("workspace/evil-pnpm"),
      "/proc/thread-self/cwd/evil-npm/bin",
      "/proc/12345/cwd/evil-bun/bin",
      "relative-asdf/shims",
      userPath("workspace/evil-nix/bin"),
    ]) {
      expect(result).not.toContain(entry);
    }
    expect(result).toEqual(expect.arrayContaining(["/opt/volta/bin", "/nix/default/bin"]));
  });
  it("excludes bins whose existing parent resolves into the workspace", () => {
    mockPaths(false, userPath("workspace"));
    vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => {
      const value = String(candidate);
      if (value === "/tmp/link") {
        return userPath("workspace");
      }
      if (value === userPath("workspace") || value === home) {
        return value;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const result = paths({ PNPM_HOME: "/tmp/link/missing", VOLTA_HOME: "/opt/volta" });
    expect(result).not.toContain("/tmp/link/missing");
    expect(result).toContain("/opt/volta/bin");
  });
  it("keeps toolchain roots when the install cwd is HOME", () => {
    mockPaths(false, home);
    const result = paths({
      PNPM_HOME: userPath(".local/share/pnpm"),
      FNM_DIR: userPath(".local/share/fnm"),
    });
    for (const suffix of ["pnpm", "pnpm/bin", "fnm/aliases/default/bin", "fnm/current/bin"]) {
      expect(result).toContain(userPath(`.local/share/${suffix}`));
    }
  });
  it("preserves Nix precedence across three profiles", () => {
    mockPaths(true);
    const profiles = [userPath(".nix-profile"), "/nix/custom", "/nix/default"];
    const result = paths({ NIX_PROFILES: profiles.toReversed().join(" ") });
    expectPathOrder(
      result,
      profiles.map((profile) => `${profile}/bin`),
    );
  });
});

describe("service environment", () => {
  it("preserves config write protection without enabling Nix mode", () => {
    const env = serviceEnv({ OPENCLAW_CONFIG_READONLY: "1" }, { platform: "linux" });
    expect([resolveIsConfigReadOnly(env), resolveIsNixMode(env)]).toEqual([true, false]);
  });
  it.each([
    ["Linux TMPDIR", { TMPDIR: "/tmp/service/" }, "linux", { TMPDIR: "/tmp/service/" }],
    [
      "profile identity",
      { OPENCLAW_PROFILE: "work" },
      "darwin",
      {
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-work.service",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (work)",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.work",
      },
    ],
  ] satisfies Array<
    [string, NodeJS.ProcessEnv, NodeJS.Platform | undefined, Record<string, string>]
  >)("preserves %s", (_name, env, platform, expected) => {
    expect(serviceEnv(env, { platform })).toMatchObject(expected);
  });
  it.each(["maintenance", "maintenance.service"])("normalizes unit override %s", (unit) => {
    expect(
      serviceEnv(
        {
          ...(unit === "maintenance" ? { OPENCLAW_PROFILE: "work" } : {}),
          OPENCLAW_SYSTEMD_UNIT: unit,
        },
        { platform: "linux" },
      ).OPENCLAW_SYSTEMD_UNIT,
    ).toBe("maintenance.service");
  });
  it("trims the proxy URL fallback", () => {
    expect(serviceEnv({ OPENCLAW_PROXY_URL: " http://127.0.0.1:3128 " }).OPENCLAW_PROXY_URL).toBe(
      "http://127.0.0.1:3128",
    );
  });
  it("does not persist ambient proxy variables", () => {
    const proxies = {
      HTTP_PROXY: " http://proxy:7890 ",
      HTTPS_PROXY: "https://proxy:7890",
      NO_PROXY: "localhost,127.0.0.1",
      http_proxy: "http://proxy:7890",
      all_proxy: "socks5://proxy:1080",
    };
    const env = serviceEnv(proxies);
    for (const key of Object.keys(proxies)) {
      expect(env[key]).toBeUndefined();
    }
  });
  it("omits Windows PATH so tasks inherit the current shell path", () => {
    const env = serviceEnv(
      { HOME: "C:\\Users\\u", PATH: "C:\\Windows\\System32;C:\\Tools" },
      { platform: "win32" },
    );
    expect(env).not.toHaveProperty("PATH");
    expect(env.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Gateway");
  });
  it.each([
    [undefined, "--max-old-space-size=8192"],
    ["/custom/launcher", ""],
  ])("retains only direct Bun's prior heap budget (wrapper=%s)", (wrapper, expected) => {
    vi.spyOn(os, "totalmem").mockReturnValue(65536 * 1024 ** 2);
    vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
    expect(serviceEnv({ OPENCLAW_WRAPPER: wrapper }, { runtime: "bun" }).NODE_OPTIONS).toBe(
      expected,
    );
  });
  it.each([
    [
      "ambient options",
      { NODE_OPTIONS: "--require /tmp/preload.js --max-old-space-size=16384" },
      {},
      "",
    ],
    [
      "existing service heap only",
      {},
      { existingNodeOptions: "--require /tmp/preload.js --max_old_space_size=6144" },
      "--max-old-space-size=6144",
    ],
  ] satisfies Array<[string, NodeJS.ProcessEnv, ServiceOptions, string]>)(
    "filters %s",
    (_name, env, options, expected) => {
      expect(serviceEnv(env, options).NODE_OPTIONS).toBe(expected);
    },
  );
  it("does not apply the Gateway heap policy to node services", () => {
    expect(buildNodeServiceEnvironment({ env: { HOME: home } }).NODE_OPTIONS).toBeUndefined();
  });
  it("retains the selected profile in the installed node environment", () => {
    expect(
      buildNodeServiceEnvironment({ env: { HOME: home, OPENCLAW_PROFILE: "work" } }),
    ).toMatchObject({
      OPENCLAW_PROFILE: "work",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.node.work",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-node-work",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node (work)",
    });
  });
  it("fences inherited Node compile cache in macOS node LaunchAgents", () => {
    const environment = buildNodeServiceEnvironment({
      env: { HOME: "/Users/u", NODE_COMPILE_CACHE: "/tmp/ambient-cache" },
      platform: "darwin",
    });
    const plist = buildLaunchAgentPlist({
      label: "ai.openclaw.node",
      programArguments: ["/usr/local/bin/node", "dist/index.js", "node", "run"],
      stdoutPath: "/tmp/node.log",
      stderrPath: "/tmp/node.err.log",
      environment,
    });
    expect(environment.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(environment.NODE_COMPILE_CACHE).toBeUndefined();
    expect(plist).toContain("<key>NODE_DISABLE_COMPILE_CACHE</key>");
    expect(plist).not.toContain("<key>NODE_COMPILE_CACHE</key>");
  });
});

it.each([
  [{ HOME: "/home/$&user", OPENCLAW_STATE_DIR: "~/state" }, path.resolve("/home/$&user/state")],
  [{ OPENCLAW_STATE_DIR: "C:\\State\\openclaw" }, "C:\\State\\openclaw"],
])("resolves state paths literally: %j", (env, expected) => {
  expect(resolveGatewayStateDir(env)).toBe(expected);
});

describe("process-owned egress trust", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "does not persist a Gateway CA on %s",
    (platform) => {
      const env = {
        HOME: home,
        NODE_EXTRA_CA_CERTS: "/state/a/secret-egress-proxy/gateway-expired/trust-bundle.pem",
      };
      for (const environment of [
        buildServiceEnvironment({ env, platform, port: 18789 }),
        buildNodeServiceEnvironment({ env, platform }),
      ]) {
        expect(environment.NODE_EXTRA_CA_CERTS).not.toEqual(
          expect.stringContaining("secret-egress-proxy"),
        );
      }
    },
  );
});
