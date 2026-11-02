import { expect } from "vitest";
import type { SessionMcpRuntime } from "../../../src/agents/agent-bundle-mcp-types.js";
import { createSessionEntryWithTranscript } from "../../../src/config/sessions/session-accessor.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";

/** Seed the same session identity that current App policy will read after Gateway admission. */
export async function seedMcpAppConformanceSession(
  runtime: SessionMcpRuntime,
  env: NodeJS.ProcessEnv,
) {
  if (!runtime.sessionKey) {
    throw new Error("Conformance runtime has no session key");
  }
  const owner = ensureGatewayOwnerProfile("MCP Conformance Viewer", { env });
  const created = await createSessionEntryWithTranscript(
    { agentId: "main", sessionKey: runtime.sessionKey, env },
    () => ({
      ok: true,
      entry: {
        sessionId: runtime.sessionId,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
      },
    }),
    { cwd: runtime.workspaceDir },
  );
  expect(created.ok).toBe(true);
}
