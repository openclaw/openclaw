import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BitwardenSecretProvider,
  BitwardenCliError,
  clearBitwardenSecretCache,
  type BitwardenProviderConfig,
} from "./bitwarden-secret-provider.js";

// ---------------------------------------------------------------------------
// Mock node:child_process execFile (used by the provider via promisify)
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function stubBw(responses: Record<string, string | Error>) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, args: unknown, _opts: unknown, callback: unknown) => {
      const argv = args as string[];
      // Strip --nointeraction and --raw flags added by runBw
      const clean = argv.filter((a) => a !== "--nointeraction" && a !== "--raw");
      const key = clean.join(" ");

      for (const [pattern, response] of Object.entries(responses)) {
        if (key === pattern || key.includes(pattern)) {
          if (response instanceof Error) {
            (callback as ExecCallback)(response, { stdout: "", stderr: response.message });
          } else {
            (callback as ExecCallback)(null, { stdout: response, stderr: "" });
          }
          return undefined as never;
        }
      }
      (callback as ExecCallback)(new Error(`Unexpected bw command: bw ${key}`), {
        stdout: "",
        stderr: "",
      });
      return undefined as never;
    },
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOGIN_ITEM = {
  id: "abc-123",
  name: "anthropic-key",
  type: 1,
  login: {
    username: "user@example.com",
    password: "sk-ant-api03-secret-key",
    uris: [{ uri: "https://console.anthropic.com" }],
  },
  notes: "Anthropic production API key",
  fields: [
    { name: "api-key", value: "sk-ant-api03-secret-key", type: 0 },
    { name: "org-id", value: "org-12345", type: 0 },
  ],
};

const STATUS_UNLOCKED = JSON.stringify({
  status: "unlocked",
  serverUrl: "https://vault.bitwarden.com",
  lastSync: "2026-02-20T10:00:00.000Z",
  userEmail: "user@example.com",
});

const STATUS_LOCKED = JSON.stringify({ status: "locked" });
const STATUS_UNAUTHENTICATED = JSON.stringify({ status: "unauthenticated" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProvider(overrides: Partial<BitwardenProviderConfig> = {}): BitwardenSecretProvider {
  return new BitwardenSecretProvider({
    cacheTtlSeconds: 0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearBitwardenSecretCache();
  vi.restoreAllMocks();
  delete process.env.BW_SESSION;
  delete process.env.BW_CLIENTID;
  delete process.env.BW_CLIENTSECRET;
  delete process.env.BW_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BitwardenSecretProvider", () => {
  // =========================================================================
  // getSecret
  // =========================================================================

  describe("getSecret", () => {
    it("resolves the password field by default (no /field suffix)", async () => {
      stubBw({ "get item anthropic-key": JSON.stringify(LOGIN_ITEM) });
      const provider = createProvider();
      const value = await provider.getSecret("anthropic-key");
      expect(value).toBe("sk-ant-api03-secret-key");
    });

    it("resolves password field explicitly via /password", async () => {
      stubBw({ "get item anthropic-key": JSON.stringify(LOGIN_ITEM) });
      const provider = createProvider();
      const value = await provider.getSecret("anthropic-key/password");
      expect(value).toBe("sk-ant-api03-secret-key");
    });

    it("resolves the username field", async () => {
      stubBw({ "get item anthropic-key": JSON.stringify(LOGIN_ITEM) });
      const provider = createProvider();
      const value = await provider.getSecret("anthropic-key/username");
      expect(value).toBe("user@example.com");
    });

    it("resolves the notes field", async () => {
      stubBw({ "get item anthropic-key": JSON.stringify(LOGIN_ITEM) });
      const provider = createProvider();
      const value = await provider.getSecret("anthropic-key/notes");
      expect(value).toBe("Anthropic production API key");
    });

    it("resolves the uri field", async () => {
      stubBw({ "get item anthropic-key": JSON.stringify(LOGIN_ITEM) });
      const provider = createProvider();
      const value = await provider.getSecret("anthropic-key/uri");
      expect(value).toBe("https://console.anthropic.com");
    });

    it("resolves a custom field by name", async () => {
      stubBw({ "get item anthropic-key": JSON.stringify(LOGIN_ITEM) });
      const provider = createProvider();
      const value = await provider.getSecret("anthropic-key/api-key");
      expect(value).toBe("sk-ant-api03-secret-key");
    });

    it("resolves a second custom field", async () => {
      stubBw({ "get item anthropic-key": JSON.stringify(LOGIN_ITEM) });
      const provider = createProvider();
      const value = await provider.getSecret("anthropic-key/org-id");
      expect(value).toBe("org-12345");
    });

    it("resolves TOTP via bw get totp", async () => {
      stubBw({ "get totp anthropic-key": "123456" });
      const provider = createProvider();
      const value = await provider.getSecret("anthropic-key/totp");
      expect(value).toBe("123456");
    });

    it("does not cache TOTP for the full provider TTL", async () => {
      stubBw({ "get totp totp-item": "111111" });
      const provider = new BitwardenSecretProvider({ cacheTtlSeconds: 300 });
      await provider.getSecret("totp-item/totp");
      // Advance time past TOTP cap (25s) but within provider TTL (300s)
      vi.useFakeTimers();
      vi.advanceTimersByTime(26_000);
      stubBw({ "get totp totp-item": "222222" });
      const second = await provider.getSecret("totp-item/totp");
      vi.useRealTimers();
      expect(second).toBe("222222");
    });

    it("returns empty string for notes when item has no notes", async () => {
      const noNotes = { ...LOGIN_ITEM, notes: null };
      stubBw({ "get item no-notes": JSON.stringify(noNotes) });
      const provider = createProvider();
      const value = await provider.getSecret("no-notes/notes");
      expect(value).toBe("");
    });

    it("returns empty string for uri when item has no URIs", async () => {
      const noUri = { ...LOGIN_ITEM, login: { ...LOGIN_ITEM.login, uris: [] } };
      stubBw({ "get item no-uri": JSON.stringify(noUri) });
      const provider = createProvider();
      const value = await provider.getSecret("no-uri/uri");
      expect(value).toBe("");
    });

    it("throws when item has no password field", async () => {
      const noPassword = { ...LOGIN_ITEM, login: { ...LOGIN_ITEM.login, password: null } };
      stubBw({ "get item no-pw": JSON.stringify(noPassword) });
      const provider = createProvider();
      await expect(provider.getSecret("no-pw")).rejects.toThrow(/no password field/);
    });

    it("throws when item has no username field", async () => {
      const noUsername = { ...LOGIN_ITEM, login: { ...LOGIN_ITEM.login, username: null } };
      stubBw({ "get item no-user": JSON.stringify(noUsername) });
      const provider = createProvider();
      await expect(provider.getSecret("no-user/username")).rejects.toThrow(/no username field/);
    });

    it("throws with available fields hint when custom field not found", async () => {
      stubBw({ "get item anthropic-key": JSON.stringify(LOGIN_ITEM) });
      const provider = createProvider();
      try {
        await provider.getSecret("anthropic-key/nonexistent");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BitwardenCliError);
        expect((err as BitwardenCliError).message).toMatch(/not found in item/);
        expect((err as BitwardenCliError).hint).toMatch(/Available fields/);
      }
    });

    it("uses cache for repeated lookups within TTL", async () => {
      stubBw({ "get item cached": JSON.stringify(LOGIN_ITEM) });
      const provider = new BitwardenSecretProvider({ cacheTtlSeconds: 60 });
      await provider.getSecret("cached");
      await provider.getSecret("cached");
      const calls = mockExecFile.mock.calls.filter((c) => {
        const argv = (c[1] as string[]).filter((a) => a !== "--nointeraction" && a !== "--raw");
        return argv.join(" ") === "get item cached";
      });
      expect(calls).toHaveLength(1);
    });
  });

  // =========================================================================
  // setSecret
  // =========================================================================

  describe("setSecret", () => {
    it("creates a new item when it does not exist", async () => {
      stubBw({
        "get item new-secret": new Error("Not found"),
        "create item": "{}",
      });
      const provider = createProvider();
      await provider.setSecret("new-secret", "my-secret-value");
      const createCall = mockExecFile.mock.calls.find((c) => (c[1] as string[])[0] === "create");
      expect(createCall).toBeDefined();
      const encoded = (createCall![1] as string[])[2];
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
      expect(decoded.name).toBe("new-secret");
      expect(decoded.login.password).toBe("my-secret-value");
    });

    it("updates an existing item password", async () => {
      stubBw({
        "get item anthropic-key": JSON.stringify(LOGIN_ITEM),
        "edit item abc-123": "{}",
      });
      const provider = createProvider();
      await provider.setSecret("anthropic-key/password", "new-key-value");
      const editCall = mockExecFile.mock.calls.find((c) => (c[1] as string[])[0] === "edit");
      expect(editCall).toBeDefined();
    });

    it("creates item with custom field when field is not password/username", async () => {
      let capturedCreateArgs: string[] = [];
      mockExecFile.mockImplementation(
        (_cmd: unknown, args: unknown, _opts: unknown, callback: unknown) => {
          const argv = args as string[];
          if (argv[0] === "get" && argv[1] === "item") {
            (callback as ExecCallback)(new Error("Not found"), { stdout: "", stderr: "" });
          } else if (argv[0] === "create") {
            capturedCreateArgs = [...argv];
            (callback as ExecCallback)(null, { stdout: "{}", stderr: "" });
          } else {
            (callback as ExecCallback)(new Error(`Unexpected: bw ${argv.join(" ")}`), {
              stdout: "",
              stderr: "",
            });
          }
          return undefined as never;
        },
      );
      const provider = createProvider();
      await provider.setSecret("custom-item/my-field", "field-value");
      expect(capturedCreateArgs[0]).toBe("create");
      expect(capturedCreateArgs[1]).toBe("item");
      const decoded = JSON.parse(Buffer.from(capturedCreateArgs[2], "base64").toString("utf-8"));
      expect(decoded.fields).toEqual([{ name: "my-field", value: "field-value", type: 0 }]);
      expect(decoded.login.password).toBeNull();
    });

    it("re-throws non-not-found errors instead of swallowing them", async () => {
      stubBw({ "get item broken": new Error("Vault is locked") });
      const provider = createProvider();
      await expect(provider.setSecret("broken/password", "val")).rejects.toThrow(/locked/i);
    });

    it("does not duplicate notes into custom fields on create", async () => {
      let capturedArgs: string[] = [];
      mockExecFile.mockImplementation(
        (_cmd: unknown, args: unknown, _opts: unknown, callback: unknown) => {
          const argv = args as string[];
          if (argv[0] === "get" && argv[1] === "item") {
            (callback as ExecCallback)(new Error("Not found"), { stdout: "", stderr: "" });
          } else if (argv[0] === "create") {
            capturedArgs = [...argv];
            (callback as ExecCallback)(null, { stdout: "{}", stderr: "" });
          } else {
            (callback as ExecCallback)(null, { stdout: "{}", stderr: "" });
          }
          return undefined as never;
        },
      );
      const provider = createProvider();
      await provider.setSecret("note-item/notes", "my note content");
      const decoded = JSON.parse(Buffer.from(capturedArgs[2], "base64").toString("utf-8"));
      expect(decoded.notes).toBe("my note content");
      expect(decoded.fields).toEqual([]);
    });
  });

  // =========================================================================
  // listSecrets
  // =========================================================================

  describe("listSecrets", () => {
    it("lists all item names", async () => {
      const items = [
        { id: "1", name: "anthropic-key", type: 1 },
        { id: "2", name: "openai-key", type: 1 },
        { id: "3", name: "telegram-bot", type: 1 },
      ];
      stubBw({ "list items": JSON.stringify(items) });
      const provider = createProvider();
      const names = await provider.listSecrets();
      expect(names).toEqual(["anthropic-key", "openai-key", "telegram-bot"]);
    });

    it("filters by collectionId when configured", async () => {
      stubBw({ "list items --collectionid col-abc": JSON.stringify([]) });
      const provider = createProvider({ collectionId: "col-abc" });
      const names = await provider.listSecrets();
      expect(names).toEqual([]);
      const call = mockExecFile.mock.calls.find((c) =>
        (c[1] as string[]).includes("--collectionid"),
      );
      expect(call).toBeDefined();
    });

    it("returns empty array when vault is empty", async () => {
      stubBw({ "list items": "[]" });
      const provider = createProvider();
      const names = await provider.listSecrets();
      expect(names).toEqual([]);
    });
  });

  // =========================================================================
  // testConnection
  // =========================================================================

  describe("testConnection", () => {
    it("returns ok when vault is unlocked and sync succeeds", async () => {
      stubBw({ status: STATUS_UNLOCKED, sync: "" });
      const provider = createProvider();
      const result = await provider.testConnection();
      expect(result).toEqual({ ok: true });
    });

    it("returns error when vault is locked", async () => {
      stubBw({ status: STATUS_LOCKED });
      const provider = createProvider();
      const result = await provider.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/locked/i);
    });

    it("returns error when not logged in", async () => {
      stubBw({ status: STATUS_UNAUTHENTICATED });
      const provider = createProvider();
      const result = await provider.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not logged in/i);
    });

    it("returns error when bw CLI is not installed", async () => {
      stubBw({ status: new Error("ENOENT") });
      const provider = createProvider();
      const result = await provider.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });
  });

  // =========================================================================
  // CLI error mapping
  // =========================================================================

  describe("error handling", () => {
    it("throws helpful error when bw CLI is missing", async () => {
      stubBw({ "get item x": new Error("ENOENT: bw not found") });
      const provider = createProvider();
      const err = await provider.getSecret("x").catch((e: Error) => e);
      expect(err).toBeInstanceOf(BitwardenCliError);
      expect((err as BitwardenCliError).hint).toMatch(/install/i);
    });

    it("throws helpful error when vault is locked", async () => {
      stubBw({ "get item x": new Error("Vault is locked") });
      const provider = createProvider();
      const err = await provider.getSecret("x").catch((e: Error) => e);
      expect(err).toBeInstanceOf(BitwardenCliError);
      expect((err as BitwardenCliError).hint).toMatch(/bw unlock/i);
    });

    it("throws helpful error when not logged in", async () => {
      stubBw({ "get item x": new Error("You are not logged in") });
      const provider = createProvider();
      const err = await provider.getSecret("x").catch((e: Error) => e);
      expect(err).toBeInstanceOf(BitwardenCliError);
      expect((err as BitwardenCliError).hint).toMatch(/bw login/i);
    });

    it("throws helpful error when multiple items match", async () => {
      stubBw({ "get item x": new Error("More than one result was found") });
      const provider = createProvider();
      try {
        await provider.getSecret("x");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BitwardenCliError);
        expect((err as BitwardenCliError).message).toMatch(/item ID/i);
      }
    });
  });

  // =========================================================================
  // Configuration
  // =========================================================================

  describe("configuration", () => {
    it("does not mutate process.env when sessionKey is provided", () => {
      createProvider({ sessionKey: "test-session-key" });
      expect(process.env.BW_SESSION).toBeUndefined();
    });

    it("does not mutate process.env when API key auth is configured", () => {
      createProvider({ clientId: "cid", clientSecret: "csec" });
      expect(process.env.BW_CLIENTID).toBeUndefined();
      expect(process.env.BW_CLIENTSECRET).toBeUndefined();
    });

    it("does not mutate process.env when serverUrl is provided", () => {
      createProvider({ serverUrl: "https://vw.example.com" });
      expect(process.env.BW_URL).toBeUndefined();
    });

    it("defaults cacheTtlMs to 300 seconds", () => {
      const provider = new BitwardenSecretProvider({});
      expect(provider.cacheTtlMs).toBe(300_000);
    });

    it("respects custom cacheTtlSeconds", () => {
      const provider = new BitwardenSecretProvider({ cacheTtlSeconds: 60 });
      expect(provider.cacheTtlMs).toBe(60_000);
    });

    it("provider name is bw", () => {
      const provider = createProvider();
      expect(provider.name).toBe("bw");
    });
  });
});
