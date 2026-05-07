import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentWorkerPermissionExecArgv } from "./permissions.js";

describe("agent worker permissions", () => {
  it("builds deterministic Node permission flags for an agent worker", () => {
    const workspaceDir = path.resolve("/tmp/openclaw-worker/workspace");
    const agentDir = path.resolve("/tmp/openclaw-worker/agent");
    const sessionFile = path.resolve("/tmp/openclaw-worker/agent/session.jsonl");
    const storePath = path.resolve("/tmp/openclaw-worker/state/sessions.json");

    const args = buildAgentWorkerPermissionExecArgv({
      workspaceDir,
      agentDir,
      sessionFile,
      storePath,
      readRoots: [workspaceDir],
      writeRoots: [path.join(workspaceDir, "out/*")],
    });

    expect(args[0]).toBe("--permission");
    expect(args).toContain(`--allow-fs-read=${workspaceDir}`);
    expect(args).toContain(`--allow-fs-read=${workspaceDir}/*`);
    expect(args).toContain(`--allow-fs-read=${agentDir}/*`);
    expect(args).toContain(`--allow-fs-read=${sessionFile}`);
    expect(args).toContain(`--allow-fs-read=${sessionFile}.lock`);
    expect(args).toContain(`--allow-fs-read=${storePath}`);
    expect(args).toContain(`--allow-fs-read=${storePath}.lock`);
    expect(args).toContain(`--allow-fs-read=${path.resolve("src/*")}`);
    expect(args).toContain(`--allow-fs-read=${path.resolve("extensions/*")}`);
    expect(args).toContain(`--allow-fs-write=${workspaceDir}/*`);
    expect(args).toContain(`--allow-fs-write=${path.join(workspaceDir, "out/*")}`);
    expect(args).toContain(`--allow-fs-write=${agentDir}/*`);
    expect(args).toContain(`--allow-fs-write=${sessionFile}`);
    expect(args).toContain(`--allow-fs-write=${sessionFile}.lock`);
    expect(args).toContain(`--allow-fs-write=${path.dirname(sessionFile)}/*`);
    expect(args).toContain(`--allow-fs-write=${storePath}`);
    expect(args).toContain(`--allow-fs-write=${storePath}.lock`);
    expect(args).toContain(`--allow-fs-write=${path.dirname(storePath)}/*`);
    expect(args.filter((arg) => arg === "--permission")).toHaveLength(1);
    const firstWriteArg = args.findIndex((arg) => arg.startsWith("--allow-fs-write="));
    const lastReadArg = args.findLastIndex((arg) => arg.startsWith("--allow-fs-read="));
    expect(firstWriteArg).toBeGreaterThan(0);
    expect(lastReadArg).toBeLessThan(firstWriteArg);
  });
});
