/** Tests the attested native Claude login owner used to authorize saved history. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClaudeManagedSettings } from "../../test/helpers/claude-managed-settings.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  attestClaudeNativeLoginOwner,
  readClaudeNativeLoginOwner,
} from "./provider-auth-claude-compat.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const writeJson = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
const writeCredentials = (dir: string, value: Record<string, unknown> = credentials()) =>
  writeJson(path.join(dir, ".credentials.json"), { claudeAiOauth: value });

function makeHome(files: {
  account?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
}): string {
  const home = tempDirs.make("openclaw-claude-owner-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  if (files.account) {
    writeJson(path.join(home, ".claude.json"), { oauthAccount: files.account });
  }
  if (files.credentials) {
    writeCredentials(path.join(home, ".claude"), files.credentials);
  }
  return home;
}

// Each synthetic token names the account a stub profile endpoint returns for it, so an
// owner shows exactly which credential was read. Unique per call: attestations are cached.
const tokenFor = (accountUuid: string) => `token-${accountUuid}-${randomUUID()}`;
const credentials = (extra: Record<string, unknown> = {}) => ({
  accessToken: tokenFor("uuid-a"),
  expiresAt: Date.parse("2030-01-01T00:00:00Z"),
  ...extra,
});
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

function profileFetch() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get("authorization") ?? "";
    const match = /^Bearer token-(.+)-[0-9a-f-]{36}$/u.exec(bearer);
    return match
      ? Response.json({ account: { uuid: match[1] } })
      : new Response("{}", { status: 401 });
  });
}

/** Attests with a stub endpoint and returns the owner, as the history boundary would. */
async function attest(
  options: Parameters<typeof attestClaudeNativeLoginOwner>[0] = {},
  fetchFn: typeof fetch = profileFetch() as never,
) {
  return (await attestClaudeNativeLoginOwner({ fetchFn, ...options })).owner;
}

const { realpathSync } = fs;
let managedSettingsDir: string;
let managedFixturePath: ReturnType<typeof mockClaudeManagedSettings>;

beforeEach(() => {
  managedSettingsDir = tempDirs.make("openclaw-claude-managed-");
  managedFixturePath = mockClaudeManagedSettings(managedSettingsDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("attestClaudeNativeLoginOwner", () => {
  it("owns a credential for account B by B even beside an account record for A", async () => {
    const homeDir = makeHome({
      account: { accountUuid: "uuid-a", emailAddress: "a@example.com" },
      credentials: credentials({ accessToken: tokenFor("uuid-b") }),
    });
    expect(await attest({ homeDir, platform: "linux" })).toBe("uuid:uuid-b");
    expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBe("uuid:uuid-b");
  });

  it("sends only the access token, only to the Anthropic profile endpoint, bounded", async () => {
    const homeDir = makeHome({ credentials: credentials() });
    const fetchFn = profileFetch();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await attest({ homeDir, platform: "linux" }, fetchFn as never);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(PROFILE_URL);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(3_000);
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer token-uuid-a-/u);
  });

  it.each([
    ["an HTTP 401", async () => new Response("{}", { status: 401 })],
    [
      "an error status whose body still names an account",
      async () => Response.json({ account: { uuid: "uuid-a" } }, { status: 403 }),
    ],
    ["a body without an account uuid", async () => Response.json({ account: { email: "a@x" } })],
    ["a body that is not JSON", async () => new Response("<html>", { status: 200 })],
    [
      "a network error that echoes the request",
      async (_url: unknown, init?: RequestInit) => {
        throw new Error(`failed: ${new Headers(init?.headers).get("authorization")}`);
      },
    ],
  ])("has no owner, and caches nothing, after %s", async (_label, response) => {
    const homeDir = makeHome({ credentials: credentials() });
    const result = await attestClaudeNativeLoginOwner({
      homeDir,
      platform: "linux",
      fetchFn: vi.fn(response) as never,
    });
    expect(result.owner).toBeUndefined();
    expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBeUndefined();
    expect(await attest({ homeDir, platform: "linux" })).toBe("uuid:uuid-a");
  });

  describe("attestation cache", () => {
    it("answers the synchronous check only for a token this process attested", async () => {
      const homeDir = makeHome({ credentials: credentials() });
      const fetchFn = profileFetch();
      expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBeUndefined();
      expect(await attest({ homeDir, platform: "linux" }, fetchFn as never)).toBe("uuid:uuid-a");
      expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBe("uuid:uuid-a");
      expect(await attest({ homeDir, platform: "linux" }, fetchFn as never)).toBe("uuid:uuid-a");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      // A rotated token has no owner until it is attested itself.
      writeCredentials(path.join(homeDir, ".claude"));
      expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBeUndefined();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("never asks the network for an expired token, but keeps an owner attested before", async () => {
      const expired = Date.parse("2020-01-01T00:00:00Z");
      const token = tokenFor("uuid-a");
      const homeDir = makeHome({
        credentials: credentials({ accessToken: token, expiresAt: expired }),
      });
      const fetchFn = profileFetch();
      expect(await attest({ homeDir, platform: "linux" }, fetchFn as never)).toBeUndefined();
      expect(fetchFn).not.toHaveBeenCalled();
      // The same token, attested while it was still valid, keeps its owner after expiry.
      const write = (expiresAt: number) =>
        writeCredentials(path.join(homeDir, ".claude"), { accessToken: token, expiresAt });
      write(Date.parse("2030-01-01T00:00:00Z"));
      expect(await attest({ homeDir, platform: "linux" }, fetchFn as never)).toBe("uuid:uuid-a");
      write(expired);
      const later = await attestClaudeNativeLoginOwner({
        homeDir,
        platform: "linux",
        fetchFn: fetchFn as never,
      });
      expect(later).toEqual({ owner: "uuid:uuid-a", refreshDueAt: expired - 10 * 60_000 });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("evicts the oldest attestation beyond its bound", async () => {
      const homeDir = makeHome({ credentials: credentials() });
      const fetchFn = profileFetch();
      await attest({ homeDir, platform: "linux" }, fetchFn as never);
      const first = fs.readFileSync(path.join(homeDir, ".claude", ".credentials.json"), "utf8");
      for (let index = 0; index < 64; index += 1) {
        writeCredentials(path.join(homeDir, ".claude"));
        await attest({ homeDir, platform: "linux" }, fetchFn as never);
      }
      fs.writeFileSync(path.join(homeDir, ".claude", ".credentials.json"), first);
      expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBeUndefined();
    });
  });

  it("does not trust a leftover account record without a credential", async () => {
    const homeDir = makeHome({ account: { accountUuid: "uuid-a" } });
    const fetchFn = profileFetch();
    expect(await attest({ homeDir, platform: "linux" }, fetchFn as never)).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe("supplied environment", () => {
    const loginIn = (dir: string, accountUuid: string) => {
      writeJson(path.join(dir, ".claude.json"), { oauthAccount: { accountUuid } });
      writeCredentials(dir, credentials({ accessToken: tokenFor(accountUuid) }));
    };
    const configLogin = () => {
      const configDir = tempDirs.make("openclaw-claude-config-");
      loginIn(configDir, "uuid-a");
      return { configDir, env: { CLAUDE_CONFIG_DIR: configDir } };
    };

    it("reads the config dir the child receives, not the process one", async () => {
      const processDir = tempDirs.make("openclaw-claude-process-");
      const childDir = tempDirs.make("openclaw-claude-child-");
      loginIn(processDir, "uuid-process");
      loginIn(childDir, "uuid-child");
      vi.stubEnv("CLAUDE_CONFIG_DIR", processDir);
      expect(await attest({ platform: "linux" })).toBe("uuid:uuid-process");
      expect(await attest({ platform: "linux", env: { CLAUDE_CONFIG_DIR: childDir } })).toBe(
        "uuid:uuid-child",
      );
    });

    it("does not fall back to the process env for variables the child lacks", async () => {
      const processDir = tempDirs.make("openclaw-claude-process-");
      loginIn(processDir, "uuid-process");
      vi.stubEnv("CLAUDE_CONFIG_DIR", processDir);
      const emptyHome = tempDirs.make("openclaw-claude-empty-home-");
      expect(await attest({ platform: "linux", env: { HOME: emptyHome } })).toBe(undefined);
    });

    it("reads the child's API key helper and secure-storage split", async () => {
      const { configDir, env } = configLogin();
      expect(await attest({ platform: "linux", env })).toBe("uuid:uuid-a");
      writeJson(path.join(configDir, "settings.json"), { apiKeyHelper: "echo synthetic" });
      expect(await attest({ platform: "linux", env })).toBeUndefined();
      fs.rmSync(path.join(configDir, "settings.json"));
      const secureDir = tempDirs.make("openclaw-claude-secure-");
      loginIn(secureDir, "uuid-a");
      expect(
        await attest({
          platform: "linux",
          env: { ...env, CLAUDE_SECURESTORAGE_CONFIG_DIR: secureDir },
        }),
      ).toBeUndefined();
    });

    it("has no owner when the user settings env block selects another login", async () => {
      const { configDir, env } = configLogin();
      writeJson(path.join(configDir, "settings.json"), { env: { UNRELATED: "1" } });
      expect(await attest({ platform: "linux", env })).toBe("uuid:uuid-a");
      writeJson(path.join(configDir, "settings.json"), {
        env: { CLAUDE_CODE_USE_BEDROCK: "synthetic" },
      });
      expect(await attest({ platform: "linux", env })).toBeUndefined();
    });

    it("has no owner when Claude's managed settings or a drop-in select another login", async () => {
      const { env } = configLogin();
      const options = { platform: "linux" as const, env };
      const writeManaged = (file: string, value: unknown) => {
        fs.mkdirSync(path.dirname(path.join(managedSettingsDir, file)), { recursive: true });
        writeJson(path.join(managedSettingsDir, file), value);
      };
      // Claude skips hidden and non-JSON drop-ins.
      writeManaged("managed-settings.json", { env: { DISABLE_TELEMETRY: "1" } });
      writeManaged("managed-settings.d/.10-auth.json", { apiKeyHelper: "echo synthetic" });
      writeManaged("managed-settings.d/10-auth.txt", { env: { ANTHROPIC_API_KEY: "synthetic" } });
      expect(await attest(options)).toBe("uuid:uuid-a");
      writeManaged("managed-settings.json", { apiKeyHelper: "echo synthetic" });
      expect(readClaudeNativeLoginOwner(options)).toBeUndefined();
      expect(await attest(options)).toBeUndefined();
      writeManaged("managed-settings.json", {});
      writeManaged("managed-settings.d/20-auth.json", { env: { ANTHROPIC_API_KEY: "synthetic" } });
      expect(await attest(options)).toBeUndefined();
    });

    it("keeps the owner when a managed settings file cannot be resolved", async () => {
      const { env } = configLogin();
      const options = { platform: "linux" as const, env };
      expect(await attest(options)).toBe("uuid:uuid-a");
      vi.mocked(fs.realpathSync).mockImplementation(((target: fs.PathLike) => {
        if (managedFixturePath(target)) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return realpathSync(target);
      }) as typeof fs.realpathSync);
      expect(readClaudeNativeLoginOwner(options)).toBe("uuid:uuid-a");
      expect(await attest(options)).toBe("uuid:uuid-a");
    });

    it.each([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ])("has no owner when the child selects %s instead of the stored login", async (key) => {
      const { env } = configLogin();
      expect(await attest({ platform: "linux", env: { ...env, [key]: "1" } })).toBeUndefined();
    });

    it("has no owner for a relative config root the child would resolve against its own cwd", async () => {
      const { configDir } = configLogin();
      const relative = path.relative(process.cwd(), configDir);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(
        await attest({ platform: "linux", env: { CLAUDE_CONFIG_DIR: relative } }),
      ).toBeUndefined();
    });

    it("derives the Keychain service and account from the child's environment", async () => {
      const { env } = configLogin();
      const commands: string[] = [];
      const execSync = vi.fn((command: string) => {
        commands.push(command);
        throw new Error("not found");
      }) as never;
      await attest({
        platform: "darwin",
        execSync,
        env: { ...env, USER: "child-user" },
      });
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command).toContain('-a "child-user"');
        expect(command).toMatch(/-s "Claude Code-credentials-[0-9a-f]{8}"/u);
      }
    });
  });

  describe("macOS Keychain", () => {
    const keychainPayload = JSON.stringify({
      claudeAiOauth: credentials({ accessToken: tokenFor("uuid-keychain") }),
    });
    const absent = Object.assign(new Error("Item not found"), { status: 44 });
    const timeout = Object.assign(new Error("security ETIMEDOUT"), {
      code: "ETIMEDOUT",
      status: null,
    });
    const locked = Object.assign(new Error("locked"), { status: 36 });
    it.each([
      ["readable Keychain", keychainPayload, "", "uuid:uuid-keychain"],
      ["denied password with existing metadata", new Error("denied"), "", undefined],
      ["timed out lookups", timeout, timeout, undefined],
      ["locked lookups", locked, locked, undefined],
      ["unusable Keychain payload", JSON.stringify({ claudeAiOauth: {} }), "", undefined],
      ["absent password", absent, "", "uuid:uuid-a"],
      ["absent metadata after failed password", timeout, absent, "uuid:uuid-a"],
    ] as const)(
      "resolves %s without trusting a stale credentials file",
      async (_label, password, metadata, owner) => {
        const homeDir = makeHome({
          account: { accountUuid: "uuid-a" },
          credentials: credentials(),
        });
        const execSync = vi.fn((command: string) => {
          const result = command.includes(" -w ") ? password : metadata;
          if (result instanceof Error) {
            throw result;
          }
          return result;
        });
        expect(await attest({ homeDir, platform: "darwin", execSync: execSync as never })).toBe(
          owner,
        );
      },
    );
  });
});
