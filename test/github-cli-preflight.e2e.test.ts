// E2E: a Gateway host without gh rejects authorization before device-code issuance.
import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SessionGitHubReadinessResultSchema } from "../packages/gateway-protocol/src/schema/session-github-publication.js";
import { resolveExecutablePath } from "../src/infra/executable-path.js";
import { runCommandWithTimeout } from "../src/process/exec.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const instances: OpenClawTestInstance[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
});

describe("GitHub CLI authorization preflight", () => {
  it(
    "returns installation guidance through the real CLI and Gateway without requesting a code",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const gatewayPath = path.dirname(process.execPath);
      expect(resolveExecutablePath("gh", { env: { PATH: gatewayPath } })).toBeUndefined();

      const instance = await createOpenClawTestInstance({
        name: "github-cli-preflight",
        env: { PATH: gatewayPath, OPENCLAW_PATH_BOOTSTRAPPED: "1" },
      });
      instances.push(instance);
      await instance.startGateway();

      const result = await instance.cli([
        "gateway",
        "call",
        "tools.github.authorize.start",
        "--params",
        '{"scope":"agent","agentId":"main"}',
        "--json",
      ]);

      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain(
        "GitHub CLI (`gh`) is required on the Gateway host. Install it and retry.",
      );
      expect(output).not.toContain("github.com/login/device");
      expect(output).not.toContain("userCode");
    },
  );
});

it("observes configured GitHub host readiness through the shipped CLI and owned Gateway", async () => {
  const instance = await createOpenClawTestInstance({
    name: "github-host-readiness-cli",
    config: {
      gateway: {
        github: { host: "github.example.test", apiBaseUrl: "https://github.example.test/api/v3" },
      },
      models: { catalogRefresh: { enabled: false } },
      update: { checkOnStart: false },
    },
    env: { GH_TOKEN: "", GITHUB_TOKEN: "", GH_ENTERPRISE_TOKEN: "" },
  });
  instances.push(instance);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
      timeoutMs: 15_000,
      env: { ...instance.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const result = await instance.cli(
      ["gateway", "call", method, "--params", JSON.stringify(params), "--json"],
      { timeoutMs: 30_000 },
    );
    expect(result.code, result.stderr).toBe(0);
    const value: unknown = JSON.parse(result.stdout);
    return value;
  };
  const sources = ["github.com", "github.example.test"];
  for (const host of sources) {
    const origin = path.join(instance.homeDir, host);
    await fs.mkdir(origin, { recursive: true });
    await git(origin, "init", "-b", "main");
    await fs.writeFile(path.join(origin, "README.md"), "synthetic local source\n");
    await git(origin, "add", "README.md");
    await git(
      origin,
      "-c",
      "user.name=Readiness Fixture",
      "-c",
      "user.email=readiness@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "fixture",
    );
    await git(origin, "remote", "add", "origin", `https://${host}/example/readiness.git`);
  }
  const entrypoint = await instance.entrypoint();
  expect(entrypoint).toEqual([expect.stringMatching(/^dist\/index\.(?:js|mjs)$/)]);
  console.log("GITHUB_READINESS_BUILT_ENTRYPOINT " + JSON.stringify(entrypoint));
  await instance.startGateway();
  const worktrees = [];
  for (const [index, host] of sources.entries()) {
    const key = `agent:main:host-readiness-${index}`;
    await rpc("sessions.create", {
      key,
      agentId: "main",
      permissionMode: "full",
      worktree: true,
      worktreeName: `host-readiness-${index}`,
      worktreeBaseRef: "main",
      cwd: path.join(instance.homeDir, host),
    });
    const described = z
      .object({
        session: z.object({ execCwd: z.string().optional(), spawnedCwd: z.string().optional() }),
      })
      .parse(await rpc("sessions.describe", { key }));
    const cwd = described.session.execCwd ?? described.session.spawnedCwd;
    expect(cwd).toBeTruthy();
    if (!cwd) {
      throw new Error("Public session description omitted its worktree");
    }
    await fs.writeFile(path.join(cwd, "unpublished.txt"), "preserve me\n");
    worktrees.push({
      key,
      host,
      cwd,
      head: await git(cwd, "rev-parse", "HEAD"),
      status: await git(cwd, "status", "--porcelain"),
    });
  }
  for (const [index, host] of [
    "github.example.test",
    "github.com",
    "github.example.test",
  ].entries()) {
    if (index > 0) {
      // Public configuration changes require Gateway restart; preserve the same owned state.
      await instance.stopGateway();
      const configured = await instance.cli([
        "config",
        "set",
        "gateway.github",
        JSON.stringify({
          host,
          apiBaseUrl: host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`,
        }),
      ]);
      expect(configured.code, configured.stderr).toBe(0);
      await instance.startGateway();
    }
    for (const entry of worktrees) {
      const expected = entry.host === host ? "supported" : "unsupported";
      const observation = await rpc("sessions.github.readiness", { sessionKey: entry.key });
      expect(Value.Check(SessionGitHubReadinessResultSchema, observation)).toBe(true);
      expect(observation).toMatchObject({
        policy: { read: "admitted", write: "unknown" },
        custody: { kind: "qualified", source: "worktree" },
        target: { kind: expected },
      });
      // A credential-free Gateway may leave receipts unavailable; observation must not activate publication.
      expect(observation).not.toHaveProperty("request.receipt");
      console.log(
        "GITHUB_READINESS_PUBLIC_PROOF " +
          JSON.stringify({ configuredHost: host, originHost: entry.host, readiness: observation }),
      );
      if (expected === "supported") {
        expect(await rpc("sessions.github.readiness", { sessionKey: entry.key })).toMatchObject({
          target: { kind: "supported", freshness: "cached" },
        });
      }
      expect(await git(entry.cwd, "rev-parse", "HEAD")).toBe(entry.head);
      expect(await git(entry.cwd, "status", "--porcelain")).toBe(entry.status);
      expect(await fs.readFile(path.join(entry.cwd, "unpublished.txt"), "utf8")).toBe(
        "preserve me\n",
      );
    }
  }
}, 240_000);
