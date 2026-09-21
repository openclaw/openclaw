import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { createProjectsHandlers } from "./projects.js";

export const execFileAsync = promisify(execFile);
export const listRegistryRecords = vi.fn(async () => []);
export const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
  checkoutRoot: checkoutPath,
  repoRoot: checkoutPath,
  originUrl: "",
  fingerprint: checkoutPath,
}));
export const projectsHandlers = createProjectsHandlers({
  listRegistryRecords,
  resolveRepositoryIdentity,
} as never);

export async function initializeRepository(
  root: string,
  name = "registered",
  originUrl = "https://github.com/openclaw/openclaw.git",
): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@openclaw.invalid"]);
  await execFileAsync("git", ["-C", repo, "remote", "add", "origin", originUrl]);
  await fs.writeFile(path.join(repo, "README.md"), "registered\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  return await fs.realpath(repo);
}

export async function invokeProjectMethod(
  method: keyof typeof projectsHandlers,
  params: Record<string, unknown>,
  cfg = {},
  scopes: string[] = ["operator.write"],
  profileId?: string,
  handlers = projectsHandlers,
  projection?: SessionRowProjection,
) {
  const capture: {
    result: {
      ok: boolean;
      payload?: unknown;
      error?: { code?: string; message?: string };
    } | null;
  } = { result: null };
  const ownedProjection =
    !projection && method === "projects.list" && profileId && !params.includeObserved
      ? await createSessionRowProjection({ cfg, modelCatalog: [] })
      : undefined;
  try {
    await handlers[method]!({
      req: {} as never,
      params,
      respond: (ok, payload, error) => {
        capture.result = { ok, payload, error };
      },
      context: bindSessionRowProjection(
        { getRuntimeConfig: () => cfg as OpenClawConfig },
        () => projection ?? ownedProjection,
      ) as never,
      client: {
        connect: { scopes },
        ...(profileId ? { authenticatedUserProfile: { profileId } } : {}),
      } as never,
      isWebchatConnect: () => false,
    });
    return capture.result;
  } finally {
    ownedProjection?.dispose();
  }
}
