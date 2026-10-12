/** Tests the attested native Claude login owner used to authorize saved history. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  attestClaudeNativeLoginOwner,
  readClaudeNativeLoginOwner,
} from "./provider-auth-claude-compat.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeHome(files: {
  account?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}): string {
  const home = tempDirs.make("openclaw-claude-owner-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const write = (file: string, value: unknown) =>
    fs.writeFileSync(path.join(home, file), JSON.stringify(value), "utf8");
  if (files.account) {
    write(".claude.json", { oauthAccount: files.account });
  }
  if (files.credentials) {
    write(path.join(".claude", ".credentials.json"), { claudeAiOauth: files.credentials });
  }
  if (files.settings) {
    write(path.join(".claude", "settings.json"), files.settings);
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
      ? Response.json({
          account: { uuid: match[1], email: `${match[1]}@example.com` },
          organization: { uuid: "org-1" },
        })
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("attestClaudeNativeLoginOwner", () => {
  it("names the account Anthropic attests for the credential", async () => {
    const homeDir = makeHome({
      account: { accountUuid: "uuid-a", emailAddress: "a@example.com" },
      credentials: credentials(),
    });
    expect(await attest({ homeDir, platform: "linux" })).toBe("uuid:uuid-a");
  });

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
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(3_000);
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer token-uuid-a-/u);
  });

  it.each([
    ["an HTTP 401", async () => new Response("{}", { status: 401 })],
    ["an HTTP 500", async () => new Response("{}", { status: 500 })],
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
    expect(JSON.stringify(result)).not.toContain("token-");
    expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBeUndefined();
    expect(await attest({ homeDir, platform: "linux" })).toBe("uuid:uuid-a");
  });

  it("has no owner when the profile lookup times out", async () => {
    const homeDir = makeHome({ credentials: credentials() });
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const fetchFn = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.throwIfAborted();
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted", { cause: init.signal?.reason })),
          );
        }),
    );
    expect(await attest({ homeDir, platform: "linux" }, fetchFn as never)).toBeUndefined();
  });

  describe("attestation cache", () => {
    it("answers the synchronous check only for a token this process attested", async () => {
      const homeDir = makeHome({ credentials: credentials() });
      const fetchFn = profileFetch();
      expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBeUndefined();
      expect(await attest({ homeDir, platform: "linux" }, fetchFn as never)).toBe("uuid:uuid-a");
      expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBe("uuid:uuid-a");
      // A second attestation of the same token needs no request.
      expect(await attest({ homeDir, platform: "linux" }, fetchFn as never)).toBe("uuid:uuid-a");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      // A rotated token has no owner until it is attested itself.
      fs.writeFileSync(
        path.join(homeDir, ".claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: credentials() }),
      );
      expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBeUndefined();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("never asks the network for an expired token, but keeps an owner attested before", async () => {
      const expired = Date.parse("2020-01-01T00:00:00Z");
      const homeDir = makeHome({ credentials: credentials({ expiresAt: expired }) });
      const fetchFn = profileFetch();
      expect(await attest({ homeDir, platform: "linux" }, fetchFn as never)).toBeUndefined();
      expect(fetchFn).not.toHaveBeenCalled();
      // The same token, attested while it was still valid, keeps its owner after expiry.
      const fresh = makeHome({ credentials: credentials() });
      const token = JSON.parse(
        fs.readFileSync(path.join(fresh, ".claude", ".credentials.json"), "utf8"),
      ).claudeAiOauth.accessToken;
      expect(await attest({ homeDir: fresh, platform: "linux" }, fetchFn as never)).toBe(
        "uuid:uuid-a",
      );
      fs.writeFileSync(
        path.join(fresh, ".claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: expired } }),
      );
      const later = await attestClaudeNativeLoginOwner({
        homeDir: fresh,
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
        fs.writeFileSync(
          path.join(homeDir, ".claude", ".credentials.json"),
          JSON.stringify({ claudeAiOauth: credentials() }),
        );
        await attest({ homeDir, platform: "linux" }, fetchFn as never);
      }
      fs.writeFileSync(path.join(homeDir, ".claude", ".credentials.json"), first);
      expect(readClaudeNativeLoginOwner({ homeDir, platform: "linux" })).toBeUndefined();
    });
  });

  it("keeps the owner when the plan or token changes", async () => {
    const account = { accountUuid: "uuid-a" };
    const basic = makeHome({ account, credentials: credentials() });
    const upgraded = makeHome({
      account,
      credentials: credentials({
        accessToken: tokenFor("uuid-a"),
        refreshToken: "synthetic-refresh",
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      }),
    });
    expect(await attest({ homeDir: basic, platform: "linux" })).toBe(
      await attest({ homeDir: upgraded, platform: "linux" }),
    );
  });

  it("does not trust a leftover account record without a credential", async () => {
    const homeDir = makeHome({ account: { accountUuid: "uuid-a" } });
    const fetchFn = profileFetch();
    expect(await attest({ homeDir, platform: "linux" }, fetchFn as never)).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("needs no account record", async () => {
    const homeDir = makeHome({ credentials: credentials() });
    expect(await attest({ homeDir, platform: "linux" })).toBe("uuid:uuid-a");
  });

  it("fails closed when the credential root differs from the account config root", async () => {
    const configDir = tempDirs.make("openclaw-claude-config-");
    const secureDir = tempDirs.make("openclaw-claude-secure-");
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", secureDir);
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-a" } }),
    );
    fs.writeFileSync(
      path.join(secureDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: credentials() }),
    );
    expect(await attest({ platform: "linux" })).toBeUndefined();
  });

  describe("supplied environment", () => {
    const loginIn = (dir: string, accountUuid: string) => {
      fs.writeFileSync(
        path.join(dir, ".claude.json"),
        JSON.stringify({ oauthAccount: { accountUuid } }),
      );
      fs.writeFileSync(
        path.join(dir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: credentials({ accessToken: tokenFor(accountUuid) }) }),
      );
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
      const configDir = tempDirs.make("openclaw-claude-config-");
      loginIn(configDir, "uuid-a");
      const env = { CLAUDE_CONFIG_DIR: configDir };
      expect(await attest({ platform: "linux", env })).toBe("uuid:uuid-a");
      fs.writeFileSync(
        path.join(configDir, "settings.json"),
        JSON.stringify({ apiKeyHelper: "echo synthetic" }),
      );
      expect(await attest({ platform: "linux", env })).toBeUndefined();
      fs.rmSync(path.join(configDir, "settings.json"));
      const secureDir = tempDirs.make("openclaw-claude-secure-");
      expect(
        await attest({
          platform: "linux",
          env: { ...env, CLAUDE_SECURESTORAGE_CONFIG_DIR: secureDir },
        }),
      ).toBeUndefined();
    });

    it("has no owner when the user settings env block selects another login", async () => {
      const configDir = tempDirs.make("openclaw-claude-config-");
      loginIn(configDir, "uuid-a");
      const env = { CLAUDE_CONFIG_DIR: configDir };
      fs.writeFileSync(
        path.join(configDir, "settings.json"),
        JSON.stringify({ env: { UNRELATED: "1" } }),
      );
      expect(await attest({ platform: "linux", env })).toBe("uuid:uuid-a");
      for (const key of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_API_KEY"]) {
        fs.writeFileSync(
          path.join(configDir, "settings.json"),
          JSON.stringify({ env: { [key]: "synthetic" } }),
        );
        expect(await attest({ platform: "linux", env })).toBeUndefined();
      }
    });

    it.each([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ])("has no owner when the child selects %s instead of the stored login", async (key) => {
      const configDir = tempDirs.make("openclaw-claude-config-");
      loginIn(configDir, "uuid-a");
      expect(
        await attest({
          platform: "linux",
          env: { CLAUDE_CONFIG_DIR: configDir, [key]: "1" },
        }),
      ).toBeUndefined();
    });

    it("has no owner for a relative config root the child would resolve against its own cwd", async () => {
      const configDir = tempDirs.make("openclaw-claude-config-");
      loginIn(configDir, "uuid-a");
      const relative = path.relative(process.cwd(), configDir);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(
        await attest({ platform: "linux", env: { CLAUDE_CONFIG_DIR: relative } }),
      ).toBeUndefined();
    });

    it("derives the Keychain service and account from the child's environment", async () => {
      const configDir = tempDirs.make("openclaw-claude-config-");
      loginIn(configDir, "uuid-a");
      const commands: string[] = [];
      const execSync = vi.fn((command: string) => {
        commands.push(command);
        throw new Error("not found");
      }) as never;
      await attest({
        platform: "darwin",
        execSync,
        env: { CLAUDE_CONFIG_DIR: configDir, USER: "child-user" },
      });
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command).toContain('-a "child-user"');
        expect(command).toMatch(/-s "Claude Code-credentials-[0-9a-f]{8}"/u);
      }
    });
  });

  it("has no owner when an API key helper replaces the login", async () => {
    const homeDir = makeHome({
      account: { accountUuid: "uuid-a" },
      credentials: credentials(),
      settings: { apiKeyHelper: "echo synthetic" },
    });
    expect(await attest({ homeDir, platform: "linux" })).toBeUndefined();
  });

  describe("macOS Keychain", () => {
    // The Keychain and the file beside it hold different accounts' tokens.
    const keychainPayload = JSON.stringify({
      claudeAiOauth: credentials({ accessToken: tokenFor("uuid-keychain") }),
    });
    // `security` exits 44 (errSecItemNotFound) only when the item does not exist.
    const notFound = () =>
      Object.assign(new Error("The specified item could not be found in the keychain."), {
        status: 44,
      });

    it("reads the Keychain login without trusting the file beside it", async () => {
      const homeDir = makeHome({ account: { accountUuid: "uuid-a" }, credentials: credentials() });
      const execSync = vi.fn(() => keychainPayload) as never;
      expect(await attest({ homeDir, platform: "darwin", execSync })).toBe("uuid:uuid-keychain");
    });

    it("fails closed when the Keychain item exists but cannot be read", async () => {
      const homeDir = makeHome({
        account: { accountUuid: "uuid-a" },
        credentials: credentials(),
      });
      // `-w` reads fail (locked or access denied) while the metadata-only lookup succeeds.
      const execSync = vi.fn((command: string) => {
        if (command.includes(" -w ")) {
          throw new Error("denied");
        }
        return "";
      }) as never;
      expect(await attest({ homeDir, platform: "darwin", execSync })).toBeUndefined();
    });

    it("uses the credentials file when no Keychain item exists", async () => {
      const homeDir = makeHome({
        account: { accountUuid: "uuid-a" },
        credentials: credentials(),
      });
      const execSync = vi.fn(() => {
        throw notFound();
      }) as never;
      expect(await attest({ homeDir, platform: "darwin", execSync })).toBe("uuid:uuid-a");
    });

    describe("ambiguous lookups with a stale credentials file", () => {
      const stale = () =>
        makeHome({ account: { accountUuid: "uuid-a" }, credentials: credentials() });
      const calls = (execSync: unknown) =>
        (execSync as { mock: { calls: unknown[][] } }).mock.calls;
      const timeout = () =>
        Object.assign(new Error("spawnSync /usr/bin/security ETIMEDOUT"), {
          code: "ETIMEDOUT",
          status: null,
        });

      it("refuses when both lookups fail for a reason other than absence", async () => {
        for (const failure of [
          () => new Error("denied"),
          timeout,
          () => Object.assign(new Error("locked"), { status: 36 }),
          () => Object.assign(new Error("spawn"), { code: "ENOENT" }),
        ]) {
          const execSync = vi.fn(() => {
            throw failure();
          }) as never;
          expect(await attest({ homeDir: stale(), platform: "darwin", execSync })).toBeUndefined();
          expect(calls(execSync)).toHaveLength(2);
        }
      });

      it("refuses when the password lookup fails and the metadata lookup confirms the item", async () => {
        const execSync = vi.fn((command: string) => {
          if (command.includes(" -w ")) {
            throw timeout();
          }
          return "";
        }) as never;
        expect(await attest({ homeDir: stale(), platform: "darwin", execSync })).toBeUndefined();
      });

      it.each(["not json", "[]", "42", "null"])(
        "refuses an unusable Keychain payload (%s) without consulting the file",
        async (payload) => {
          const execSync = vi.fn(() => payload) as never;
          expect(await attest({ homeDir: stale(), platform: "darwin", execSync })).toBeUndefined();
        },
      );

      it("lets the file stand on a confirmed absence from the password lookup alone", async () => {
        const execSync = vi.fn(() => {
          throw notFound();
        }) as never;
        expect(await attest({ homeDir: stale(), platform: "darwin", execSync })).toBe(
          "uuid:uuid-a",
        );
        expect(calls(execSync)).toHaveLength(1);
      });

      it("lets the file stand when a failed password lookup is followed by a confirmed absence", async () => {
        const execSync = vi.fn((command: string) => {
          if (command.includes(" -w ")) {
            throw timeout();
          }
          throw notFound();
        }) as never;
        expect(await attest({ homeDir: stale(), platform: "darwin", execSync })).toBe(
          "uuid:uuid-a",
        );
      });

      it("reads the Keychain login when the password lookup succeeds", async () => {
        const execSync = vi.fn(() => keychainPayload) as never;
        expect(await attest({ homeDir: stale(), platform: "darwin", execSync })).toBe(
          "uuid:uuid-keychain",
        );
      });
    });
  });
});
