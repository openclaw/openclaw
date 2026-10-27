import { coerceErrorMessage } from "@openclaw/normalization-core";
import { setConfiguredMcpServer, unsetConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { withMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { digestClawValue } from "./digest.js";
import { CLAW_MCP_REF_SCHEMA_VERSION, type PersistedClawMcpServerRef } from "./mcp-records.js";
import type { ClawMutationStateOptions } from "./state-mutation-options.js";
import type { ClawAddPlan, ClawMcpServer } from "./types.js";

export type { PersistedClawMcpServerRef } from "./mcp-records.js";

export class ClawMcpInstallError extends Error {
  constructor(
    message: string,
    readonly mcpServers: PersistedClawMcpServerRef[],
  ) {
    super(message);
    this.name = "ClawMcpInstallError";
  }
}

function mcpServerFromActionDetails(details: Record<string, unknown>): ClawMcpServer | undefined {
  const { expectedState: _expectedState, prerequisites: _prerequisites, ...server } = details;
  return "command" in server || "url" in server ? (server as ClawMcpServer) : undefined;
}

export function digestClawMcpServer(server: Record<string, unknown>): string {
  return digestClawValue(canonicalizeConfiguredMcpServer(server));
}

/** Add a shared MCP requirement without creating a Claw ownership record. */
export async function installClawMcpServersStateless(
  plan: ClawAddPlan,
  options: ClawMutationStateOptions & {
    assertForwardCurrent?: () => void;
    nowMs?: number;
  } = {},
): Promise<PersistedClawMcpServerRef[]> {
  const refs: PersistedClawMcpServerRef[] = [];
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    await withMcpLifecycleLease(action.id, options, async (lease) => {
      const assertCurrent = () => {
        lease.assertCurrent();
        options.assertCurrent?.();
        options.assertForwardCurrent?.();
      };
      const server = action.details ? mcpServerFromActionDetails(action.details) : undefined;
      if (!server) {
        throw new ClawMcpInstallError(
          `MCP server action ${JSON.stringify(action.id)} is invalid.`,
          refs,
        );
      }
      const listed = await listConfiguredMcpServers();
      assertCurrent();
      if (!listed.ok) {
        throw new ClawMcpInstallError(listed.error, refs);
      }
      const configured = listed.mcpServers[action.id];
      const configDigest = digestClawMcpServer(server);
      if (configured && digestClawMcpServer(configured) !== configDigest) {
        throw new ClawMcpInstallError(
          `MCP server ${JSON.stringify(action.id)} already exists with different configuration.`,
          refs,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const ref: PersistedClawMcpServerRef = {
        schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        name: action.id,
        configDigest,
        relationship: configured ? "referenced" : "managed",
        origin: configured ? "pre-existing" : "claw-introduced",
        independentOwner: true,
        status: "complete",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      if (!configured) {
        try {
          const result = await setConfiguredMcpServer({
            name: action.id,
            server,
            createOnly: true,
            skipLifecycleLease: true,
            assertCurrent,
            assertCurrentAsync: async () => {
              await options.prepareEffect?.();
              await lease.assertOwned();
              assertCurrent();
            },
          });
          if (!result.ok) {
            throw new ClawMcpInstallError(result.error, refs);
          }
          refs.push(ref);
          assertCurrent();
        } catch (error) {
          if (error instanceof ClawMcpInstallError) {
            throw error;
          }
          throw new ClawMcpInstallError(coerceErrorMessage(error), refs);
        }
      }
      if (configured) {
        refs.push(ref);
      }
    });
  }
  return refs;
}

/** Remove unchanged MCP entries introduced before a failed Add published its agent. */
export async function rollbackStatelessClawMcpServers(
  refs: PersistedClawMcpServerRef[],
  options: ClawMutationStateOptions = {},
): Promise<string[]> {
  const errors: string[] = [];
  for (const ref of refs.toReversed()) {
    if (ref.origin !== "claw-introduced" || ref.status !== "complete") {
      continue;
    }
    try {
      await withMcpLifecycleLease(ref.name, options, async (lease) => {
        const assertCurrent = () => {
          lease.assertCurrent();
          options.assertCurrent?.();
        };
        const listed = await listConfiguredMcpServers();
        assertCurrent();
        if (!listed.ok) {
          throw new Error(listed.error);
        }
        const configured = listed.mcpServers[ref.name];
        if (!configured) {
          refs.splice(refs.indexOf(ref), 1);
          return;
        }
        if (digestClawMcpServer(configured) !== ref.configDigest) {
          return;
        }
        const removed = await unsetConfiguredMcpServer({
          name: ref.name,
          expectedServer: configured,
          skipLifecycleLease: true,
          assertCurrent,
          assertCurrentAsync: async () => {
            await options.prepareEffect?.();
            await lease.assertOwned();
            assertCurrent();
          },
        });
        assertCurrent();
        if (!removed.ok) {
          // A concurrent change is not ours to remove.
          if (removed.error.includes("changed and was not removed")) {
            return;
          }
          throw new Error(removed.error);
        }
        refs.splice(refs.indexOf(ref), 1);
      });
    } catch (error) {
      errors.push(`MCP server ${ref.name} cleanup failed: ${coerceErrorMessage(error)}`);
    }
  }
  return errors;
}
