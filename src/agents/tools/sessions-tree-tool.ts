import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { listPendingRequestsForChild } from "../orchestrator-request-registry.js";
import { listAllSubagentRuns, type SubagentRunRecord } from "../subagent-registry.js";
import { jsonResult } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";
import { getDescendants } from "./sessions-lineage.js";

const SessionsTreeToolSchema = Type.Object({
  depth: Type.Optional(Type.Number({ minimum: 0 })),
});

type SessionsTreeNode = {
  key: string;
  label: string;
  depth: number;
  status: "running" | "completed" | "error" | "timeout";
  runStatus?: "running" | "blocked" | "input_required" | "idle" | "completed" | "error" | "timeout";
  pendingRequestCount?: number;
  runtimeMs: number;
  children: SessionsTreeNode[];
};

function sortRuns(runs: SubagentRunRecord[]): SubagentRunRecord[] {
  return [...runs].toSorted((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.childSessionKey.localeCompare(b.childSessionKey);
  });
}

function resolveStatus(run: SubagentRunRecord): SessionsTreeNode["status"] {
  if (!run.endedAt) {
    return "running";
  }
  const outcome = run.outcome?.status;
  if (outcome === "error") {
    return "error";
  }
  if (outcome === "timeout") {
    return "timeout";
  }
  return "completed";
}

function resolveRuntimeMs(run: SubagentRunRecord) {
  const start = typeof run.startedAt === "number" ? run.startedAt : run.createdAt;
  const end = typeof run.endedAt === "number" ? run.endedAt : Date.now();
  return Math.max(0, end - start);
}

export function createSessionsTreeTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_tree",
    description: "Show the subagent session spawn tree with status and runtime.",
    parameters: SessionsTreeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const maxDepth =
        typeof params.depth === "number" && Number.isFinite(params.depth)
          ? Math.max(0, Math.floor(params.depth))
          : undefined;

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterKeyRaw = opts?.agentSessionKey?.trim();
      const requesterKey = requesterKeyRaw
        ? resolveInternalSessionKey({
            key: requesterKeyRaw,
            alias,
            mainKey,
          })
        : undefined;

      const allRuns = listAllSubagentRuns();
      const visibleRuns = (() => {
        if (!requesterKey || !isSubagentSessionKey(requesterKey)) {
          return allRuns;
        }
        const allowed = new Set([requesterKey, ...getDescendants(requesterKey)]);
        return allRuns.filter((run) => allowed.has(run.childSessionKey));
      })();

      const runByChildKey = new Map(visibleRuns.map((run) => [run.childSessionKey, run]));
      const childrenByRequester = new Map<string, SubagentRunRecord[]>();
      for (const run of visibleRuns) {
        const list = childrenByRequester.get(run.requesterSessionKey) ?? [];
        list.push(run);
        childrenByRequester.set(run.requesterSessionKey, list);
      }

      const roots = sortRuns(
        visibleRuns.filter((run) => !runByChildKey.has(run.requesterSessionKey)),
      );

      const buildNode = (
        run: SubagentRunRecord,
        relativeDepth: number,
        fallbackDepth: number,
        path: Set<string>,
      ): SessionsTreeNode => {
        const key = run.childSessionKey;
        const nodeDepth = typeof run.depth === "number" ? run.depth : fallbackDepth;
        const status = resolveStatus(run);
        const runtimeMs = resolveRuntimeMs(run);
        const pendingRequests = listPendingRequestsForChild(key);
        const runStatus =
          pendingRequests.length > 0
            ? ("blocked" as const)
            : status === "running"
              ? ("running" as const)
              : undefined;
        const pendingRequestCount = pendingRequests.length > 0 ? pendingRequests.length : undefined;
        const nextPath = new Set(path);
        nextPath.add(key);

        let children: SessionsTreeNode[] = [];
        if (maxDepth === undefined || relativeDepth < maxDepth) {
          const childRuns = sortRuns(childrenByRequester.get(key) ?? []);
          children = childRuns
            .filter((child) => !nextPath.has(child.childSessionKey))
            .map((child) => buildNode(child, relativeDepth + 1, nodeDepth + 1, nextPath));
        }

        return {
          key,
          label: run.label?.trim() || run.task,
          depth: nodeDepth,
          status,
          ...(runStatus && { runStatus }),
          ...(pendingRequestCount && { pendingRequestCount }),
          runtimeMs,
          children,
        };
      };

      const tree = roots.map((root) => buildNode(root, 0, 1, new Set<string>()));
      const total = visibleRuns.length;
      const active = visibleRuns.filter((run) => !run.endedAt).length;
      const completed = visibleRuns.filter((run) => !!run.endedAt).length;

      return jsonResult({
        active,
        completed,
        total,
        tree,
      });
    },
  };
}
