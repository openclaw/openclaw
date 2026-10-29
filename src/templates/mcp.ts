import { coerceErrorMessage } from "@openclaw/normalization-core";
import { setConfiguredMcpServer, unsetConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { withMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { digestTemplateValue } from "./digest.js";
import {
  TEMPLATE_MCP_REF_SCHEMA_VERSION,
  type PersistedTemplateMcpServerRef,
} from "./mcp-records.js";
import type { TemplateMutationStateOptions } from "./state-mutation-options.js";
import type { TemplateAddPlan, TemplateMcpServer } from "./types.js";

export type { PersistedTemplateMcpServerRef } from "./mcp-records.js";

function mcpServerFromActionDetails(
  details: Record<string, unknown>,
): TemplateMcpServer | undefined {
  const { expectedState: _expectedState, prerequisites: _prerequisites, ...server } = details;
  return "command" in server || "url" in server ? (server as TemplateMcpServer) : undefined;
}

export function digestTemplateMcpServer(server: Record<string, unknown>): string {
  return digestTemplateValue(canonicalizeConfiguredMcpServer(server));
}

/**
 * Add a shared MCP requirement without creating a Template ownership record.
 * Each ref is recorded in the caller's `refs` before its write, because a write
 * that throws may still have committed. Rollback re-reads the config and drops
 * refs with no matching entry.
 */
export async function installTemplateMcpServersStateless(
  plan: Pick<TemplateAddPlan, "actions"> & { agent: Pick<TemplateAddPlan["agent"], "finalId"> },
  options: TemplateMutationStateOptions & {
    refs: PersistedTemplateMcpServerRef[];
    assertForwardCurrent?: () => void;
    nowMs?: number;
  },
): Promise<void> {
  const { refs } = options;
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    await withMcpLifecycleLease(action.id, options, async (lease) => {
      const assertCurrent = () => {
        lease.assertCurrent();
        options.assertCurrent?.();
        options.assertForwardCurrent?.();
      };
      const server = action.details ? mcpServerFromActionDetails(action.details) : undefined;
      if (!server) {
        throw new Error(`MCP server action ${JSON.stringify(action.id)} is invalid.`);
      }
      const listed = await listConfiguredMcpServers();
      assertCurrent();
      if (!listed.ok) {
        throw new Error(listed.error);
      }
      const configured = listed.mcpServers[action.id];
      const configDigest = digestTemplateMcpServer(server);
      if (configured && digestTemplateMcpServer(configured) !== configDigest) {
        throw new Error(
          `MCP server ${JSON.stringify(action.id)} already exists with different configuration.`,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const ref: PersistedTemplateMcpServerRef = {
        schemaVersion: TEMPLATE_MCP_REF_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        name: action.id,
        configDigest,
        relationship: configured ? "referenced" : "managed",
        origin: configured ? "pre-existing" : "template-introduced",
        independentOwner: true,
        status: "complete",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      refs.push(ref);
      if (!configured) {
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
          // Refused before writing, so there is nothing to roll back.
          refs.pop();
          throw new Error(result.error);
        }
        assertCurrent();
      }
    });
  }
}

/** Remove unchanged MCP entries introduced before a failed Add published its agent. */
export async function rollbackStatelessTemplateMcpServers(
  refs: PersistedTemplateMcpServerRef[],
  options: TemplateMutationStateOptions = {},
): Promise<string[]> {
  const errors: string[] = [];
  for (const ref of refs.toReversed()) {
    if (ref.origin !== "template-introduced" || ref.status !== "complete") {
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
        if (digestTemplateMcpServer(configured) !== ref.configDigest) {
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
