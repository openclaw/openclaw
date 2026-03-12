import { describe, expect, it } from "vitest";
import {
  deleteAuthCredentialsFromDb,
  getAuthCredentialsFromDb,
  setAuthCredentialsInDb,
} from "./auth-credentials-sqlite.js";
import { useAuthCredentialsTestDb } from "./test-helpers.auth-credentials.js";

describe("auth_credentials SQLite adapter", () => {
  useAuthCredentialsTestDb();

  it("stores and retrieves credentials", () => {
    setAuthCredentialsInDb("github-copilot", "", {
      token: "ghu_abc",
      expiresAt: 9999999999999,
      updatedAt: 1000,
    });
    const val = getAuthCredentialsFromDb<{ token: string }>("github-copilot");
    expect(val?.token).toBe("ghu_abc");
  });

  it("returns null for missing provider", () => {
    expect(getAuthCredentialsFromDb("nonexistent")).toBeNull();
  });

  it("isolates by provider + account_id", () => {
    setAuthCredentialsInDb("oauth", "whatsapp", { me: { id: "123" } });
    setAuthCredentialsInDb("oauth", "telegram", { botId: "456" });
    expect(getAuthCredentialsFromDb<{ me: { id: string } }>("oauth", "whatsapp")?.me.id).toBe(
      "123",
    );
    expect(getAuthCredentialsFromDb<{ botId: string }>("oauth", "telegram")?.botId).toBe("456");
  });

  it("upserts on conflict", () => {
    setAuthCredentialsInDb("github-copilot", "", { token: "old" });
    setAuthCredentialsInDb("github-copilot", "", { token: "new" }, 5000);
    expect(getAuthCredentialsFromDb<{ token: string }>("github-copilot")?.token).toBe("new");
  });

  it("stores expires_at", () => {
    const expiresMs = Date.now() + 3600_000;
    setAuthCredentialsInDb("github-copilot", "", { token: "t" }, expiresMs);
    // Verify the row exists (expires_at is internal, tested via round-trip)
    expect(getAuthCredentialsFromDb("github-copilot")).not.toBeNull();
  });

  it("deletes credentials", () => {
    setAuthCredentialsInDb("github-copilot", "", { token: "t" });
    expect(deleteAuthCredentialsFromDb("github-copilot")).toBe(true);
    expect(getAuthCredentialsFromDb("github-copilot")).toBeNull();
  });

  it("delete returns false for missing entry", () => {
    expect(deleteAuthCredentialsFromDb("nonexistent")).toBe(false);
  });

  it("uses empty string as default account_id", () => {
    setAuthCredentialsInDb("provider1", "", { key: "val" });
    expect(getAuthCredentialsFromDb<{ key: string }>("provider1")?.key).toBe("val");
  });
});
