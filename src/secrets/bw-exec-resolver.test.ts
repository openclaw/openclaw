import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractField,
  groupByItem,
  parseRef,
  resolveSecrets,
  runBw,
} from "../../scripts/bw-exec-resolver.mjs";

const SCRIPT_PATH = path.resolve(import.meta.dirname, "../../scripts/bw-exec-resolver.mjs");

// ---------------------------------------------------------------------------
// Helper: run the wrapper script as a child process with given stdin
// ---------------------------------------------------------------------------

function runScript(
  input: string,
  envOverrides?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT_PATH],
      {
        timeout: 10_000,
        encoding: "utf8",
        env: { ...process.env, ...envOverrides },
      },
      (err, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          code: err && "code" in err ? (err.code as unknown as number) : 0,
        });
      },
    );
    child.stdin?.end(input);
  });
}

// ---------------------------------------------------------------------------
// Helper: create a fake bw script that returns canned responses
// ---------------------------------------------------------------------------

function createMockBwScript(tmpDir: string, responseMap: Record<string, string>): string {
  const scriptPath = path.join(tmpDir, "bw");
  // Build a Node script that reads args, looks up response, writes to stdout
  const cases = Object.entries(responseMap)
    .map(
      ([key, value]) =>
        `  if (args.includes("${key}")) { process.stdout.write(${JSON.stringify(value)}); process.exit(0); }`,
    )
    .join("\n");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2).filter(a => a !== "--nointeraction" && a !== "--raw");
${cases}
process.stderr.write("Not found.");
process.exit(1);
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return tmpDir;
}

// ---------------------------------------------------------------------------
// parseRef
// ---------------------------------------------------------------------------

describe("parseRef", () => {
  it("defaults to password when no slash present", () => {
    expect(parseRef("my-item")).toEqual({ itemQuery: "my-item", field: "password" });
  });

  it("extracts field after last slash", () => {
    expect(parseRef("my-item/username")).toEqual({ itemQuery: "my-item", field: "username" });
  });

  it("handles item names with slashes by using last slash", () => {
    expect(parseRef("folder/sub/notes")).toEqual({ itemQuery: "folder/sub", field: "notes" });
  });

  it("handles single-char field name", () => {
    expect(parseRef("item/x")).toEqual({ itemQuery: "item", field: "x" });
  });

  it("handles empty field after trailing slash", () => {
    expect(parseRef("item/")).toEqual({ itemQuery: "item", field: "" });
  });
});

// ---------------------------------------------------------------------------
// extractField
// ---------------------------------------------------------------------------

describe("extractField", () => {
  const loginItem = {
    id: "abc-123",
    name: "test-item",
    type: 1,
    login: {
      username: "user@example.com",
      password: "sk-secret-key",
      uris: [{ uri: "https://api.example.com" }],
    },
    notes: "Some notes here",
    fields: [
      { name: "api-key", value: "custom-api-key", type: 0 },
      { name: "org-id", value: "org-12345", type: 0 },
    ],
  };

  const minimalItem = {
    id: "def-456",
    name: "minimal",
    type: 1,
  };

  it("extracts password field", () => {
    expect(extractField(loginItem, "password")).toBe("sk-secret-key");
  });

  it("extracts username field", () => {
    expect(extractField(loginItem, "username")).toBe("user@example.com");
  });

  it("extracts notes field", () => {
    expect(extractField(loginItem, "notes")).toBe("Some notes here");
  });

  it("extracts uri field", () => {
    expect(extractField(loginItem, "uri")).toBe("https://api.example.com");
  });

  it("extracts custom field by name", () => {
    expect(extractField(loginItem, "api-key")).toBe("custom-api-key");
    expect(extractField(loginItem, "org-id")).toBe("org-12345");
  });

  it("returns null for missing password", () => {
    expect(extractField(minimalItem, "password")).toBeNull();
  });

  it("returns null for missing username", () => {
    expect(extractField(minimalItem, "username")).toBeNull();
  });

  it("returns empty string for missing notes", () => {
    expect(extractField(minimalItem, "notes")).toBe("");
  });

  it("returns empty string for missing uris", () => {
    expect(extractField(minimalItem, "uri")).toBe("");
  });

  it("returns null for nonexistent custom field", () => {
    expect(extractField(loginItem, "nonexistent")).toBeNull();
  });

  it("returns null for custom field when item has no fields array", () => {
    expect(extractField(minimalItem, "some-field")).toBeNull();
  });

  it("converts custom field value to string", () => {
    const item = {
      id: "x",
      name: "x",
      type: 1,
      fields: [{ name: "num", value: 42, type: 0 }],
    };
    expect(extractField(item, "num")).toBe("42");
  });

  it("handles null notes", () => {
    const item = { id: "x", name: "x", type: 1, notes: null };
    expect(extractField(item, "notes")).toBe("");
  });

  it("handles empty uris array", () => {
    const item = {
      id: "x",
      name: "x",
      type: 1,
      login: { username: null, password: null, uris: [] },
    };
    expect(extractField(item, "uri")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// groupByItem
// ---------------------------------------------------------------------------

describe("groupByItem", () => {
  it("returns empty map for empty ids", () => {
    const result = groupByItem([]);
    expect(result.size).toBe(0);
  });

  it("groups single id", () => {
    const result = groupByItem(["my-item/password"]);
    expect(result.size).toBe(1);
    expect(result.get("my-item")).toEqual([{ id: "my-item/password", field: "password" }]);
  });

  it("groups multiple fields from same item", () => {
    const result = groupByItem(["my-item/password", "my-item/username", "my-item/notes"]);
    expect(result.size).toBe(1);
    expect(result.get("my-item")).toHaveLength(3);
  });

  it("separates different items", () => {
    const result = groupByItem(["item-a/password", "item-b/password"]);
    expect(result.size).toBe(2);
    expect(result.get("item-a")).toHaveLength(1);
    expect(result.get("item-b")).toHaveLength(1);
  });

  it("defaults field to password for bare item names", () => {
    const result = groupByItem(["my-item"]);
    expect(result.get("my-item")).toEqual([{ id: "my-item", field: "password" }]);
  });

  it("groups mixed bare and slashed refs for same item", () => {
    const result = groupByItem(["my-item", "my-item/username"]);
    expect(result.size).toBe(1);
    expect(result.get("my-item")).toEqual([
      { id: "my-item", field: "password" },
      { id: "my-item/username", field: "username" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// runBw — tested via e2e with a mock bw script
// ---------------------------------------------------------------------------

describe("runBw", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  it("rejects when bw is not found", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await expect(runBw(["status"])).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ---------------------------------------------------------------------------
// resolveSecrets — e2e with mock bw script
// ---------------------------------------------------------------------------

describe("resolveSecrets (e2e with mock bw)", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  it("returns empty values and errors for empty ids", async () => {
    const result = await resolveSecrets([]);
    expect(result.values).toEqual({});
    expect(result.errors).toEqual({});
  });

  it("resolves single item password via mock bw", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-test-"));
    cleanupDirs.push(tmpDir);
    const item = JSON.stringify({
      id: "abc",
      name: "anthropic-key",
      type: 1,
      login: { password: "sk-ant-secret", username: "user@test.com", uris: [] },
      notes: null,
      fields: [],
    });
    createMockBwScript(tmpDir, { "anthropic-key": item });

    const originalPath = process.env.PATH;
    process.env.PATH = `${tmpDir}:${process.env.PATH}`;
    try {
      const result = await resolveSecrets(["anthropic-key/password"]);
      expect(result.values["anthropic-key/password"]).toBe("sk-ant-secret");
      expect(result.errors).toEqual({});
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("resolves multiple fields from same item via mock bw", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-test-"));
    cleanupDirs.push(tmpDir);
    const item = JSON.stringify({
      id: "abc",
      name: "my-creds",
      type: 1,
      login: { password: "secret123", username: "admin", uris: [{ uri: "https://example.com" }] },
      notes: "important",
      fields: [{ name: "api-key", value: "key-xyz", type: 0 }],
    });
    createMockBwScript(tmpDir, { "my-creds": item });

    const originalPath = process.env.PATH;
    process.env.PATH = `${tmpDir}:${process.env.PATH}`;
    try {
      const result = await resolveSecrets([
        "my-creds/password",
        "my-creds/username",
        "my-creds/notes",
        "my-creds/uri",
        "my-creds/api-key",
      ]);
      expect(result.values["my-creds/password"]).toBe("secret123");
      expect(result.values["my-creds/username"]).toBe("admin");
      expect(result.values["my-creds/notes"]).toBe("important");
      expect(result.values["my-creds/uri"]).toBe("https://example.com");
      expect(result.values["my-creds/api-key"]).toBe("key-xyz");
      expect(result.errors).toEqual({});
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reports per-id error for missing field", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-test-"));
    cleanupDirs.push(tmpDir);
    const item = JSON.stringify({
      id: "abc",
      name: "minimal",
      type: 1,
    });
    createMockBwScript(tmpDir, { minimal: item });

    const originalPath = process.env.PATH;
    process.env.PATH = `${tmpDir}:${process.env.PATH}`;
    try {
      const result = await resolveSecrets(["minimal/password"]);
      expect(result.values["minimal/password"]).toBeUndefined();
      expect(result.errors["minimal/password"]).toBeDefined();
      expect(result.errors["minimal/password"].message).toContain("not found");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reports per-id error when item does not exist", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-test-"));
    cleanupDirs.push(tmpDir);
    createMockBwScript(tmpDir, {});

    const originalPath = process.env.PATH;
    process.env.PATH = `${tmpDir}:${process.env.PATH}`;
    try {
      const result = await resolveSecrets(["nonexistent/password"]);
      expect(result.values["nonexistent/password"]).toBeUndefined();
      expect(result.errors["nonexistent/password"]).toBeDefined();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("resolves items from multiple different items", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-test-"));
    cleanupDirs.push(tmpDir);
    const itemA = JSON.stringify({
      id: "a",
      name: "item-a",
      type: 1,
      login: { password: "pw-a", username: null, uris: [] },
    });
    const itemB = JSON.stringify({
      id: "b",
      name: "item-b",
      type: 1,
      login: { password: "pw-b", username: null, uris: [] },
    });
    createMockBwScript(tmpDir, { "item-a": itemA, "item-b": itemB });

    const originalPath = process.env.PATH;
    process.env.PATH = `${tmpDir}:${process.env.PATH}`;
    try {
      const result = await resolveSecrets(["item-a/password", "item-b/password"]);
      expect(result.values["item-a/password"]).toBe("pw-a");
      expect(result.values["item-b/password"]).toBe("pw-b");
      expect(result.errors).toEqual({});
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end script tests (child process)
// ---------------------------------------------------------------------------

describe("bw-exec-resolver script e2e", () => {
  it("rejects unsupported protocol version", async () => {
    const result = await runScript(JSON.stringify({ protocolVersion: 99, ids: [] }));
    const parsed = JSON.parse(result.stdout);
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.errors._protocol).toBeDefined();
    expect(parsed.errors._protocol.message).toContain("Unsupported protocol version");
  });

  it("returns empty values for empty ids", async () => {
    const result = await runScript(JSON.stringify({ protocolVersion: 1, ids: [] }));
    const parsed = JSON.parse(result.stdout);
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.values).toEqual({});
    expect(parsed.errors).toBeUndefined();
  });

  it("reports errors when bw CLI is not available", async () => {
    const result = await runScript(
      JSON.stringify({ protocolVersion: 1, provider: "bw", ids: ["test-item/password"] }),
      { PATH: "/nonexistent" },
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.errors["test-item/password"]).toBeDefined();
    expect(parsed.values["test-item/password"]).toBeUndefined();
  });

  it("handles malformed JSON input gracefully", async () => {
    const result = await runScript("not json at all");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.errors._fatal).toBeDefined();
  });

  it("handles empty stdin gracefully", async () => {
    const result = await runScript("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.errors._fatal).toBeDefined();
  });
});
