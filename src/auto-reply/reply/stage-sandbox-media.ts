import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import type { MsgContext, TemplateContext } from "../templating.js";

export async function stageSandboxMedia(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: ClawdbotConfig;
  sessionKey?: string;
  workspaceDir: string;
}) {
  const { ctx, sessionCtx, cfg, sessionKey, workspaceDir } = params;
  const hasPathsArray =
    Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0;
  const pathsFromArray = Array.isArray(ctx.MediaPaths)
    ? ctx.MediaPaths
    : undefined;
  const rawPaths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : ctx.MediaPath?.trim()
        ? [ctx.MediaPath.trim()]
        : [];
  if (rawPaths.length === 0 || !sessionKey) return;

  const sandbox = await ensureSandboxWorkspaceForSession({
    config: cfg,
    sessionKey,
    workspaceDir,
  });
  if (!sandbox) return;

  const resolveAbsolutePath = (value: string): string | null => {
    let resolved = value.trim();
    if (!resolved) return null;
    if (resolved.startsWith("file://")) {
      try {
        resolved = fileURLToPath(resolved);
      } catch {
        return null;
      }
    }
    if (!path.isAbsolute(resolved)) return null;
    return resolved;
  };

  try {
    const destDir = path.join(sandbox.workspaceDir, "media", "inbound");
    await fs.mkdir(destDir, { recursive: true });

    const usedNames = new Set<string>();
    const staged = new Map<string, string>(); // absolute source -> relative sandbox path

    for (const raw of rawPaths) {
      const source = resolveAbsolutePath(raw);
      if (!source) continue;
      if (staged.has(source)) continue;

      const baseName = path.basename(source);
      if (!baseName) continue;
      const parsed = path.parse(baseName);
      let fileName = baseName;
      let suffix = 1;
      while (usedNames.has(fileName)) {
        fileName = `${parsed.name}-${suffix}${parsed.ext}`;
        suffix += 1;
      }
      usedNames.add(fileName);

      const dest = path.join(destDir, fileName);
      await fs.copyFile(source, dest);
      const relative = path.posix.join("media", "inbound", fileName);
      staged.set(source, relative);
    }

    const rewriteIfStaged = (value: string | undefined): string | undefined => {
      const raw = value?.trim();
      if (!raw) return value;
      const abs = resolveAbsolutePath(raw);
      if (!abs) return value;
      const mapped = staged.get(abs);
      return mapped ?? value;
    };

    const nextMediaPaths = hasPathsArray
      ? rawPaths.map((p) => rewriteIfStaged(p) ?? p)
      : undefined;
    if (nextMediaPaths) {
      ctx.MediaPaths = nextMediaPaths;
      sessionCtx.MediaPaths = nextMediaPaths;
      ctx.MediaPath = nextMediaPaths[0];
      sessionCtx.MediaPath = nextMediaPaths[0];
    } else {
      const rewritten = rewriteIfStaged(ctx.MediaPath);
      if (rewritten && rewritten !== ctx.MediaPath) {
        ctx.MediaPath = rewritten;
        sessionCtx.MediaPath = rewritten;
      }
    }

    if (Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length > 0) {
      const nextUrls = ctx.MediaUrls.map((u) => rewriteIfStaged(u) ?? u);
      ctx.MediaUrls = nextUrls;
      sessionCtx.MediaUrls = nextUrls;
    }
    const rewrittenUrl = rewriteIfStaged(ctx.MediaUrl);
    if (rewrittenUrl && rewrittenUrl !== ctx.MediaUrl) {
      ctx.MediaUrl = rewrittenUrl;
      sessionCtx.MediaUrl = rewrittenUrl;
    }
  } catch (err) {
    logVerbose(`Failed to stage inbound media for sandbox: ${String(err)}`);
  }
}
