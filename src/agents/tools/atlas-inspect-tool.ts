import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { atlasJsonRequest } from "./atlas-client.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const ATLAS_INSPECT_ACTIONS = [
  "context",
  "tree",
  "file",
  "search",
  "changed_files",
  "diff",
  "git_status",
] as const;

const AtlasInspectToolSchema = Type.Object({
  action: stringEnum(ATLAS_INSPECT_ACTIONS),
  repo: Type.Optional(Type.String()),
  repoDir: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  branch: Type.Optional(Type.String()),
  baseRef: Type.Optional(Type.String()),
  headRef: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  recursive: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  contextLines: Type.Optional(Type.Number({ minimum: 0 })),
  maxBytes: Type.Optional(Type.Number({ minimum: 1024 })),
});

export function createAtlasInspectTool(): AnyAgentTool {
  return {
    label: "Atlas Inspect",
    name: "atlas_inspect",
    description:
      "Read Atlas-managed repositories through a commit-pinned readonly inspect plane. Use this to resolve repo/head, read files, search code, inspect diffs, and review changed files without touching the live workspace.",
    parameters: AtlasInspectToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const repo = readStringParam(params, "repo");
      const repoDir = readStringParam(params, "repoDir");
      const ref = readStringParam(params, "ref");
      const branch = readStringParam(params, "branch");
      const baseRef = readStringParam(params, "baseRef");
      const headRef = readStringParam(params, "headRef");
      const targetPath = readStringParam(params, "path");
      const query = readStringParam(params, "query");
      const limit = readNumberParam(params, "limit", { integer: true });
      const contextLines = readNumberParam(params, "contextLines", { integer: true });
      const maxBytes = readNumberParam(params, "maxBytes", { integer: true });
      const recursive = typeof params.recursive === "boolean" ? params.recursive : undefined;

      const baseQuery = {
        repo,
        repo_dir: repoDir,
        ref,
        branch,
      };

      if (action === "context") {
        const result = await atlasJsonRequest("/api/runtime/inspect/context", {
          query: {
            ...baseQuery,
            base_ref: baseRef,
          },
        });
        return jsonResult({ ok: true, action, result });
      }
      if (action === "tree") {
        const result = await atlasJsonRequest("/api/runtime/inspect/tree", {
          query: {
            ...baseQuery,
            path: targetPath,
            recursive,
            limit,
          },
        });
        return jsonResult({ ok: true, action, result });
      }
      if (action === "file") {
        const pathValue = targetPath;
        if (!pathValue) {
          throw new Error("path required");
        }
        const result = await atlasJsonRequest("/api/runtime/inspect/file", {
          query: {
            ...baseQuery,
            path: pathValue,
            max_bytes: maxBytes,
          },
        });
        return jsonResult({ ok: true, action, result });
      }
      if (action === "search") {
        if (!query) {
          throw new Error("query required");
        }
        const result = await atlasJsonRequest("/api/runtime/inspect/search", {
          query: {
            ...baseQuery,
            q: query,
            path: targetPath,
            limit,
          },
        });
        return jsonResult({ ok: true, action, result });
      }
      if (action === "changed_files") {
        if (!baseRef || !headRef) {
          throw new Error("baseRef and headRef required");
        }
        const result = await atlasJsonRequest("/api/runtime/inspect/changed-files", {
          query: {
            repo,
            repo_dir: repoDir,
            base_ref: baseRef,
            head_ref: headRef,
          },
        });
        return jsonResult({ ok: true, action, result });
      }
      if (action === "diff") {
        if (!baseRef || !headRef) {
          throw new Error("baseRef and headRef required");
        }
        const result = await atlasJsonRequest("/api/runtime/inspect/diff", {
          query: {
            repo,
            repo_dir: repoDir,
            base_ref: baseRef,
            head_ref: headRef,
            path: targetPath,
            context: contextLines,
            max_bytes: maxBytes,
          },
        });
        return jsonResult({ ok: true, action, result });
      }
      if (action === "git_status") {
        const result = await atlasJsonRequest("/api/runtime/inspect/git-status", {
          query: {
            repo,
            repo_dir: repoDir,
          },
        });
        return jsonResult({ ok: true, action, result });
      }

      throw new Error(`Unsupported atlas_inspect action: ${action}`);
    },
  };
}
