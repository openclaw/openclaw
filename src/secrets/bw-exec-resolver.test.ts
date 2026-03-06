import { execFile } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractField, groupByItem, parseRef } from "../../scripts/bw-exec-resolver.mjs";

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
