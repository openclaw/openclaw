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
  await git(source, "commit", "--allow-empty", "-m", "installed");
  const sha = await git(source, "rev-parse", "HEAD");
  await git(source, "branch", "old-stream");
  await git(source, "commit", "--allow-empty", "-m", "available");
  const customTarget = await git(source, "rev-parse", "HEAD");
  await git(base, "clone", "--quiet", source, custom);
  await git(source, "commit", "--allow-empty", "-m", "origin advances again");
  const target = await git(source, "rev-parse", "HEAD");
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
  const refsOnly = await git(root, "ls-remote", "--refs", "upstream", "HEAD");
  expect(refsOnly.split("\n").map((line) => line.split("\t")[1])).not.toContain("HEAD");
  expect((await git(root, "ls-remote", "upstream", "HEAD")).split("\n")).toContain(
    customTarget + "\tHEAD",
  );
  const config = await fs.readFile(path.join(root, ".git", "config"), "utf8");
  mocks.root.mockResolvedValue(root);
  const matching = { root, sha, upstreamRef: "upstream/main", installedAtMs: 1234 };
  const receipts = [
    { name: "absent", receipt: null },
    {
      name: "matching custom source",
      receipt: matching,
      expected: { upstream: "upstream/main", upstreamSha: customTarget, behind: 1 },
    },
    {
      name: "abbreviated fetch source",
      receipt: { ...matching, upstreamRef: "refs/status/main" },
      expected: { upstream: "refs/status/main", upstreamSha: customTarget, behind: 1 },
    },
    {
      name: "HEAD fetch source",
      receipt: { ...matching, upstreamRef: "refs/status/head" },
      expected: { upstream: "refs/status/head", upstreamSha: customTarget, behind: 1 },
    },
    {
      name: "unambiguous short SHA",
      receipt: { ...matching, sha: sha.slice(0, 8) },
      expected: { upstream: "upstream/main", upstreamSha: customTarget, behind: 1 },
    },
    { name: "short stale SHA", receipt: { ...matching, sha: target.slice(0, 8) } },
    { name: "too short SHA", receipt: { ...matching, sha: sha.slice(0, 6) } },
    { name: "revision expression", receipt: { ...matching, sha: sha.slice(0, 8) + "^{commit}" } },
    {
      name: "valid older stream",
      receipt: { ...matching, upstreamRef: "origin/old-stream" },
      expected: { upstream: "origin/old-stream", upstreamSha: sha, behind: 0 },
    },
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
      .soft(schedule.install?.git?.status, name)
      .toBe(expected?.behind === 0 ? "current" : "behind");
    expect
      .soft(schedule.install?.git?.installedAtMs, name)
      .toBe(
        receipt?.root === root && /^[0-9a-f]{7,}$/i.test(receipt.sha) && sha.startsWith(receipt.sha)
          ? 1234
          : undefined,
      );
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
