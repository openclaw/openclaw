import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../../agents/workspace.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateFsWriteParams,
} from "../protocol/index.js";

function isLikelyBase64(input: string): boolean {
  // Reject obviously-invalid input early so we don't silently write corrupted bytes.
  // Accept unpadded base64 (we normalize padding below).
  return /^[A-Za-z0-9+/]+={0,2}$/.test(input) && input.length % 4 !== 1;
}

function normalizeBase64(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (!isLikelyBase64(trimmed)) {
    return null;
  }
  const mod = trimmed.length % 4;
  if (mod === 0) {
    return trimmed;
  }
  if (mod === 2) {
    return `${trimmed}==`;
  }
  if (mod === 3) {
    return `${trimmed}=`;
  }
  return null;
}

function resolveWorkspacePath(relativePath: string): { ok: true; absPath: string } | { ok: false } {
  const trimmed = relativePath.trim();
  if (!trimmed) {
    return { ok: false };
  }
  if (path.isAbsolute(trimmed)) {
    return { ok: false };
  }

  const absPath = path.resolve(DEFAULT_AGENT_WORKSPACE_DIR, trimmed);
  const rel = path.relative(DEFAULT_AGENT_WORKSPACE_DIR, absPath);

  // `path.relative` can return paths like "..\\.." on Windows. It also returns absolute
  // paths when drives differ, so guard both.
  if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false };
  }

  return { ok: true, absPath };
}

export const fsHandlers: GatewayRequestHandlers = {
  "fs.write": async ({ params, respond }) => {
    if (!validateFsWriteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid fs.write params: ${formatValidationErrors(validateFsWriteParams.errors)}`,
        ),
      );
      return;
    }

    const relativePath = params.path;
    const content = params.content;
    const normalizedBase64 = normalizeBase64(content);
    if (!normalizedBase64) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "content must be base64"));
      return;
    }

    const resolved = resolveWorkspacePath(relativePath);
    if (!resolved.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "path must be relative and within workspace"),
      );
      return;
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(normalizedBase64, "base64");
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          err instanceof Error ? err.message : "invalid base64",
        ),
      );
      return;
    }

    try {
      await fs.mkdir(path.dirname(resolved.absPath), { recursive: true });
      await fs.writeFile(resolved.absPath, buffer);
      respond(true, { ok: true, path: relativePath, size: buffer.length }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : "write failed"),
      );
    }
  },
};
