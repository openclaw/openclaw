import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { initSessionState } from "./session.js";

async function makeCaseDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

async function makeStorePath(prefix: string): Promise<string> {
  const root = await makeCaseDir(prefix);
  return path.join(root, "sessions.json");
}

describe("initSessionState exec security from config", () => {
  const fixtureRoots: string[] = [];

  afterAll(async () => {
    for (const dir of fixtureRoots) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("initializes execSecurity from tools.exec.security on cold boot", async () => {
    const storePath = await makeStorePath("openclaw-exec-full-");
    fixtureRoots.push(path.dirname(storePath));
    const cfg = {
      session: { store: storePath },
      tools: { exec: { security: "full" as const } },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:whatsapp:+15555550123",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.execSecurity).toBe("full");
  });

  it("keeps execSecurity undefined when config is absent", async () => {
    const storePath = await makeStorePath("openclaw-exec-none-");
    fixtureRoots.push(path.dirname(storePath));
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:whatsapp:+15555550123",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.execSecurity).toBeUndefined();
  });
});
