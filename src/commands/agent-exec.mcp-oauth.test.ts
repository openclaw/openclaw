import { describe, expect, it } from "vitest";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthStore, updateMcpOAuthStore } from "../agents/mcp-oauth-store.js";
import { readMcpOAuthCredentialsStatus, resolveMcpOAuthAccessToken } from "../agents/mcp-oauth.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { agentExecCommand } from "./agent-exec.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const IDENTITY = operatorMcpOAuthIdentity("linear", "https://mcp.example.com/mcp");
const STORED_TOKENS = {
  access_token: "stored-access",
  refresh_token: "stored-refresh",
  token_type: "bearer",
};

function successResult() {
  return {
    payloads: [{ text: "done" }],
    meta: { durationMs: 1, finalAssistantVisibleText: "done" },
  };
}

function seedStoredSession(): void {
  updateMcpOAuthStore(IDENTITY.storeKey, (store) => ({
    ...store,
    tokens: STORED_TOKENS,
    tokenExpiresAt: Date.now() + 3_600_000,
  }));
}

function countTemporaryMcpOAuthRows(): number {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        tableExists(db, "mcp_oauth_stores")
          ? (db.prepare("SELECT COUNT(*) AS rows FROM mcp_oauth_stores").get() as { rows: number })
              .rows
          : 0,
      { env: process.env },
    ) ?? 0
  );
}

describe("agent exec MCP OAuth sessions", () => {
  it("resolves and rotates a stored MCP OAuth session on the original shared root", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      seedStoredSession();
      let resolvedToken: string | undefined;
      const result = await agentExecCommand("inspect", {}, createTestRuntime(), {
        runAgent: async () => {
          expect(process.env.OPENCLAW_STATE_DIR).not.toBe(state.stateDir);
          await expect(readMcpOAuthCredentialsStatus(IDENTITY)).resolves.toMatchObject({
            state: "authorized",
          });
          resolvedToken = await resolveMcpOAuthAccessToken({ identity: IDENTITY });
          // A rotated token lands on the canonical owner, never in temporary state.
          updateMcpOAuthStore(IDENTITY.storeKey, (store) => ({
            ...store,
            tokens: { ...STORED_TOKENS, access_token: "rotated-access" },
          }));
          expect(countTemporaryMcpOAuthRows()).toBe(0);
          return successResult();
        },
      });
      expect(result.envelope.error).toBeUndefined();
      expect(resolvedToken).toBe("stored-access");
      expect(readMcpOAuthStore(IDENTITY.storeKey).tokens?.access_token).toBe("rotated-access");
    });
  });

  it("hides stored MCP OAuth sessions under --auth-env-only", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      seedStoredSession();
      const result = await agentExecCommand("inspect", { authEnvOnly: true }, createTestRuntime(), {
        runAgent: async () => {
          await expect(readMcpOAuthCredentialsStatus(IDENTITY)).resolves.toEqual({
            state: "unauthenticated",
          });
          await expect(resolveMcpOAuthAccessToken({ identity: IDENTITY })).rejects.toThrow(
            "requires OAuth authorization",
          );
          return successResult();
        },
      });
      expect(result.envelope.error).toBeUndefined();
      expect(readMcpOAuthStore(IDENTITY.storeKey).tokens).toEqual(STORED_TOKENS);
    });
  });
});
