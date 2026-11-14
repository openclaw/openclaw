import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { VerifiedGitUpdateReceipt } from "./restart-sentinel.js";
import { resolveStartupInstallStatus, withUpdateInstallStatus } from "./update-install-status.js";

const mocks = vi.hoisted(() => ({
  root: vi.fn<() => Promise<string>>(),
  receipt: vi.fn<() => Promise<VerifiedGitUpdateReceipt | null>>(),
}));
vi.mock("./openclaw-root.js", async (original) => ({
  ...(await original<typeof import("./openclaw-root.js")>()),
  resolveOpenClawPackageRoot: mocks.root,
}));
// mock-isolation: Exercise Git discovery independently of the receipt database worker.
vi.mock("./restart-sentinel.js", () => ({ readVerifiedGitUpdateReceipt: mocks.receipt }));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.resetAllMocks());

async function git(root: string, ...args: string[]) {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs: 5000 });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

it("preserves valid legacy sources without letting unusable receipts veto discovery", async () => {
  const base = await fs.realpath(dirs.make("openclaw-receipt-independent-"));
  const source = path.join(base, "source");
  const root = path.join(base, "install");
  const custom = path.join(base, "custom");
  await fs.mkdir(source);
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "user.name", "OpenClaw Test");
  await git(source, "config", "user.email", "test@openclaw.invalid");
  await git(source, "config", "commit.gpgsign", "false");
  const commit = async (message: string) => {
    await git(source, "commit", "--allow-empty", "-m", message);
    return git(source, "rev-parse", "HEAD");
  };
  const sha = await commit("installed");
  await git(source, "branch", "old-stream");
  const customTarget = await commit("available");
  await git(base, "clone", "--quiet", source, custom);
  const target = await commit("origin advances again");
  await git(base, "clone", "--quiet", source, root);
  await git(root, "checkout", "--detach", sha);
  await git(root, "branch", "-D", "main");
  await git(root, "remote", "add", "upstream", custom);
  await git(root, "fetch", "upstream");
  await git(root, "config", "--add", "remote.upstream.fetch", "+main:refs/status/main");
  await git(root, "config", "--add", "remote.upstream.fetch", "+HEAD:refs/status/head");
  // Native Git is the source-spelling oracle, independently of update discovery.
  await git(root, "fetch", "--quiet", "--no-tags", "upstream", "main", "HEAD");
  expect(await git(root, "rev-parse", "refs/status/main")).toBe(customTarget);
  expect(await git(root, "rev-parse", "refs/status/head")).toBe(customTarget);
  const config = await fs.readFile(path.join(root, ".git", "config"), "utf8");
  mocks.root.mockResolvedValue(root);
  const matching = { root, sha, upstreamRef: "upstream/main", installedAtMs: 1234 };
  const sourceCase = (name: string, upstream: string, upstreamSha = customTarget, behind = 1) => ({
    name,
    receipt: { ...matching, upstreamRef: upstream },
    expected: { upstream, upstreamSha, behind },
  });
  const receipts: Array<{
    name: string;
    receipt: VerifiedGitUpdateReceipt | null;
    expected?: ReturnType<typeof sourceCase>["expected"];
  }> = [
    { name: "absent", receipt: null },
    sourceCase("matching custom source", "upstream/main"),
    sourceCase("abbreviated fetch source", "refs/status/main"),
    sourceCase("HEAD fetch source", "refs/status/head"),
    {
      ...sourceCase("unambiguous short SHA", "upstream/main"),
      receipt: { ...matching, sha: sha.slice(0, 8) },
    },
    { name: "short stale SHA", receipt: { ...matching, sha: target.slice(0, 8) } },
    { name: "too short SHA", receipt: { ...matching, sha: sha.slice(0, 6) } },
    { name: "revision expression", receipt: { ...matching, sha: sha.slice(0, 8) + "^{commit}" } },
    sourceCase("valid older stream", "origin/old-stream", sha, 0),
    { name: "missing stream", receipt: { ...matching, upstreamRef: "origin/missing" } },
    { name: "malformed stream", receipt: { ...matching, upstreamRef: "bad ..ref" } },
    { name: "stale SHA", receipt: { ...matching, sha: target } },
    { name: "different root", receipt: { ...matching, root: source } },
  ];
  for (const { name, receipt, expected } of receipts) {
    mocks.receipt.mockResolvedValue(receipt);
    const install = await resolveStartupInstallStatus(true, new AbortController().signal);
    expect.soft(install.status.git, name).toMatchObject({
      branch: "HEAD",
      sha,
      upstream: "origin/main",
      upstreamSha: target,
      ahead: 0,
      behind: 2,
      fetchOk: true,
      ...expected,
    });
    const schedule = withUpdateInstallStatus(
      { channel: "dev", autoEnabled: true },
      install.status,
      true,
      install.installReceipt,
      root,
    );
    expect
      .soft([schedule.install?.git?.status, schedule.install?.git?.installedAtMs], name)
      .toEqual([
        expected?.behind === 0 ? "current" : "behind",
        receipt?.root === root && /^[0-9a-f]{7,}$/i.test(receipt.sha) && sha.startsWith(receipt.sha)
          ? 1234
          : undefined,
      ]);
  }
  mocks.receipt.mockResolvedValue({ ...matching, upstreamRef: "refs/remotes/upstream/main" });
  await git(root, "update-ref", "-d", "refs/remotes/upstream/main");
  await git(root, "remote", "set-url", "upstream", path.join(base, "unreachable"));
  const unavailable = await resolveStartupInstallStatus(true, new AbortController().signal);
  expect(unavailable.status.git).toMatchObject({
    upstream: "refs/remotes/upstream/main",
    upstreamSource: "receipt",
    fetchOk: false,
    upstreamSha: null,
    ahead: null,
    behind: null,
  });
  await git(root, "remote", "set-url", "upstream", custom);
  expect(await git(root, "rev-parse", "HEAD")).toBe(sha);
  expect(await fs.readFile(path.join(root, ".git", "config"), "utf8")).toBe(config);
});
