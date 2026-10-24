import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as shared from "./shared.js";
import { updateStatusCommand } from "./status.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn(),
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));
vi.mock("../../gateway/call.js", () => ({
  callGateway: async () => {
    throw new Error("Gateway unavailable");
  },
}));
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: async () => null }),
}));

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reports fresh native release preferences without changing the source checkout", async () => {
  const base = tempDirs.make("openclaw-status-channel-target-");
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-status-state-"));
  const root = path.join(base, "installed");
  const source = path.join(base, "source");
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], { timeoutMs: 5000 });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(base, "init", "--initial-branch=main", source);
  await git(source, "config", "user.name", "OpenClaw Test");
  await git(source, "config", "user.email", "test@openclaw.invalid");
  await git(source, "commit", "--allow-empty", "-m", "original release");
  await git(source, "tag", "v2026.9.1");
  await git(source, "commit", "--allow-empty", "-m", "corrected release");
  const sha = await git(source, "rev-parse", "HEAD");
  await git(source, "commit", "--allow-empty", "-m", "next release");
  const nextSha = await git(source, "rev-parse", "HEAD");
  await git(base, "clone", "--origin", "upstream", source, root);
  await git(root, "checkout", "--detach", sha);
  // Refresh a moved annotated tag privately; the installed tag stays unchanged.
  await git(source, "tag", "-f", "-a", "v2026.9.1", sha, "-m", "corrected release");
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
  const checkUpdateStatus = updateCheck.checkUpdateStatus;
  vi.spyOn(updateCheck, "checkUpdateStatus").mockImplementation((options) =>
    checkUpdateStatus({ ...options, includeRegistry: false }),
  );
  const configPath = path.join(base, "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  const read = async (config: object) => {
    await fs.writeFile(configPath, JSON.stringify(config));
    const refs = await git(root, "show-ref");
    const gitConfig = await fs.readFile(path.join(root, ".git", "config"), "utf8");
    await updateStatusCommand({ json: true });
    expect(await git(root, "show-ref")).toBe(refs);
    expect(await fs.readFile(path.join(root, ".git", "config"), "utf8")).toBe(gitConfig);
    expect(await git(root, "rev-parse", "HEAD")).toBe(sha);
    return runtime.writeJson.mock.lastCall?.[0];
  };
  const expectNoTarget = async (config: object = { update: { channel: "stable" } }) =>
    expect(await read(config)).not.toHaveProperty("update.git.preferredTarget");
  const expectTarget = async (channel: string, tag: string, targetSha: string) =>
    expect(await read({ update: { channel } })).toHaveProperty("update.git.preferredTarget", {
      channel,
      tag,
      sha: targetSha,
    });
  for (const channel of ["stable", "beta"] as const) {
    expect(await read({ update: { channel } })).toMatchObject({
      channel: { config: channel, value: channel },
      update: { git: { preferredTarget: { channel, tag: "v2026.9.1", sha } } },
    });
  }
  await git(source, "tag", "v2026.9.2-beta.1", nextSha);
  await expectTarget("beta", "v2026.9.2-beta.1", nextSha);
  await git(source, "tag", "v2026.9.2", nextSha);
  for (const channel of ["stable", "beta"] as const) {
    await expectTarget(channel, "v2026.9.2", nextSha);
  }
  await git(root, "tag", "v2026.9.3", sha);
  await expectNoTarget();
  await git(root, "tag", "-d", "v2026.9.3");
  await fs.writeFile(path.join(root, "dirty"), "uncommitted");
  await expectNoTarget();
  await fs.rm(path.join(root, "dirty"));
  for (const config of [
    {},
    { update: { channel: "dev" } },
    { update: { channel: "extended-stable" } },
    { update: { channel: "stable" }, $include: "missing.json" },
  ]) {
    await expectNoTarget(config);
  }
  await git(root, "remote", "set-url", "upstream", path.join(base, "missing-remote"));
  await expectNoTarget();
  await git(root, "remote", "remove", "upstream");
  await expectNoTarget();
  const packageRoot = tempDirs.make("openclaw-status-package-");
  await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
  vi.mocked(shared.resolveUpdateRoot).mockResolvedValue(packageRoot);
  const packaged = await read({ update: { channel: "stable" } });
  expect(packaged).toMatchObject({ update: { installKind: "package", git: undefined } });
});
