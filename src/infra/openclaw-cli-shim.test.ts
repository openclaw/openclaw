import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePreparedExecEnvironment } from "../agents/bash-tools.exec-request-preparation.js";
import { createExecTool } from "../agents/bash-tools.js";
import { resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import * as cliInvocation from "./openclaw-cli-invocation.js";
import {
  createSourceCliFixture,
  runSourceCliProbe,
  withSourceCliParent,
} from "./openclaw-cli-invocation.test-support.js";
import { clearGatewayAgentCliShim, prepareGatewayAgentCliShim } from "./openclaw-cli-shim.js";

const envSnapshot = captureEnv([
  "OPENCLAW_EXEC_SHELL_SNAPSHOT",
  "OPENCLAW_PROFILE",
  "PATH",
  "TSX_TSCONFIG_PATH",
  "TSX_DISABLE_CACHE",
]);

afterEach(() => {
  vi.restoreAllMocks();
  clearGatewayAgentCliShim();
  envSnapshot.restore();
});

function readExecText(result: Awaited<ReturnType<ReturnType<typeof createExecTool>["execute"]>>) {
  return result.content.find((entry) => entry.type === "text")?.text?.trim() ?? "";
}
function execConfig(pathPrepend?: string[]) {
  return resolveExecToolConfig({ cfg: { tools: { exec: { pathPrepend } } } });
}

describe.skipIf(process.platform === "win32")("Gateway agent CLI shim", () => {
  it("runs the source CLI version command outside the checkout", () =>
    withTempDir("openclaw-agent-cli-version-", async (root) => {
      const checkout = fileURLToPath(new URL("../../", import.meta.url));
      const entryPath = path.join(checkout, "src", "entry.ts");
      const callerCwd = path.join(root, "workspace");
      const stateDir = path.join(root, "state");
      await fs.mkdir(callerCwd);
      const env = {
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_PROFILE: "",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      };
      const parent = { entryPath, execArgv: ["--import", "tsx"] };
      await withEnvAsync(env, () => withSourceCliParent(parent, prepareGatewayAgentCliShim));
      const bin = path.join(stateDir, "tmp", "agent-cli");
      const result = runSourceCliProbe(path.join(bin, "openclaw"), ["--version"], callerCwd, {
        env,
      });
      expect(result).toMatchObject({ status: 0, stdout: expect.stringMatching(/^OpenClaw \d+\./) });
    }));

  it.each([
    { profile: "work", expectedArgs: ["--profile", "work", "probe"] },
    { profile: undefined, expectedArgs: ["probe"] },
  ])("pins the running CLI before configured PATH entries (profile=$profile)", (testCase) =>
    withTempDir("openclaw-agent-cli-shim-", async (root) => {
      const fixture = await createSourceCliFixture(root);
      const staleBinDir = path.join(root, "stale-bin");
      const staleCliPath = path.join(staleBinDir, "openclaw");
      const stateDir = path.join(root, "state");
      await fs.mkdir(staleBinDir, { recursive: true });
      await fs.writeFile(staleCliPath, "#!/bin/sh\nprintf '%s\\n' '{\"source\":\"stale\"}'\n", {
        mode: 0o700,
      });

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROFILE: testCase.profile }, () =>
        withSourceCliParent(fixture, prepareGatewayAgentCliShim),
      );
      const shimBinDir = path.join(stateDir, "tmp", "agent-cli");
      const config = execConfig([staleBinDir]);

      process.env.OPENCLAW_EXEC_SHELL_SNAPSHOT = "0";
      process.env.PATH = `${staleBinDir}${path.delimiter}${process.env.PATH ?? ""}`;
      delete process.env.OPENCLAW_PROFILE;
      delete process.env.TSX_TSCONFIG_PATH;
      process.env.TSX_DISABLE_CACHE = "1";
      const tool = createExecTool({
        ...config,
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: fixture.callerCwd,
        notifyOnExit: false,
      });
      const result = await tool.execute("gateway-cli-version-probe", {
        command: "openclaw probe",
        yieldMs: 120_000,
      });
      expect(JSON.parse(readExecText(result))).toMatchObject({
        source: "gateway",
        args: testCase.expectedArgs,
        cwd: fixture.callerCwd,
        pathHead: shimBinDir,
      });
    }),
  );

  it("renders an upgrade-stable Homebrew interpreter into the launcher", () =>
    withTempDir("openclaw-agent-cli-shim-brew-", async (root) => {
      const cellarNode = path.join(root, "Cellar", "node", "26.8.2", "bin", "node");
      const stableNode = path.join(root, "opt", "node", "bin", "node");
      for (const interpreter of [cellarNode, stableNode]) {
        await fs.mkdir(path.dirname(interpreter), { recursive: true });
        await fs.writeFile(interpreter, "", "utf8");
      }
      vi.spyOn(cliInvocation, "resolveCurrentOpenClawCliInvocation").mockReturnValue({
        command: cellarNode,
        args: [path.join(root, "dist", "index.js")],
        cwd: root,
      });

      const stateDir = path.join(root, "state");
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROFILE: "" },
        prepareGatewayAgentCliShim,
      );

      const shim = await fs.readFile(path.join(stateDir, "tmp", "agent-cli", "openclaw"), "utf8");
      expect(shim).toContain(`exec ${quoteCliArg(stableNode)} `);
      expect(shim).not.toContain("Cellar");
    }));

  it("keeps the resolved interpreter when no stable Homebrew path exists", () =>
    withTempDir("openclaw-agent-cli-shim-brew-keg-", async (root) => {
      const cellarNode = path.join(root, "Cellar", "node", "26.8.2", "bin", "node");
      await fs.mkdir(path.dirname(cellarNode), { recursive: true });
      await fs.writeFile(cellarNode, "", "utf8");
      vi.spyOn(cliInvocation, "resolveCurrentOpenClawCliInvocation").mockReturnValue({
        command: cellarNode,
        args: [path.join(root, "dist", "index.js")],
        cwd: root,
      });

      const stateDir = path.join(root, "state");
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROFILE: "" },
        prepareGatewayAgentCliShim,
      );

      const shim = await fs.readFile(path.join(stateDir, "tmp", "agent-cli", "openclaw"), "utf8");
      expect(shim).toContain(`exec ${quoteCliArg(cellarNode)} `);
    }));
});

it.each([
  { configured: undefined, expectedWarnings: [] },
  {
    configured: ["/opt/operator/bin"],
    expectedWarnings: [
      "Warning: tools.exec.pathPrepend is ignored for host=node. Configure PATH on the node host/service instead.",
    ],
  },
])(
  "warns about node-host pathPrepend only for operator entries (configured=$configured)",
  ({ configured, expectedWarnings }) =>
    withTempDir("openclaw-agent-cli-shim-node-", async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, prepareGatewayAgentCliShim);
      const config = execConfig(configured);
      expect(config.pathPrepend?.[0]).toBe(path.join(stateDir, "tmp", "agent-cli"));

      const warnings: string[] = [];
      resolvePreparedExecEnvironment({
        execParams: { command: "openclaw --version" },
        host: "node",
        defaultPathPrepend: config.pathPrepend ?? [],
        warnings,
      });
      expect(warnings).toEqual(expectedWarnings);
    }),
);

it("renders a Windows PATH launcher for the running CLI", () =>
  withTempDir("openclaw-agent-cli-shim-win-", async (root) => {
    vi.spyOn(cliInvocation, "resolveCurrentOpenClawCliInvocation").mockReturnValue({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\OpenClaw\\dist\\index.js"],
      cwd: "C:\\OpenClaw %USERPROFILE%!",
    });
    await withMockedWindowsPlatform(() =>
      withEnvAsync(
        { OPENCLAW_STATE_DIR: root, OPENCLAW_PROFILE: "work" },
        prepareGatewayAgentCliShim,
      ),
    );
    expect(await fs.readFile(path.join(root, "tmp", "agent-cli", "openclaw.cmd"), "utf8")).toBe(
      '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"C:\\Program Files\\nodejs\\node.exe" C:\\OpenClaw\\dist\\index.js --profile work %*\r\n',
    );
  }));

it.skipIf(process.platform === "win32")(
  "binds native Git past forwarding shims without rediscovering them",
  () =>
    withTempDir("agent-git-recursion-", async (root) => {
      const fixture = await createSourceCliFixture(root);
      const stateDir = path.join(root, "state");
      const userBin = path.join(root, "user-bin");
      const aliasBin = path.join(root, "alias-bin");
      const trace = path.join(root, "shim-trace");
      await fs.mkdir(userBin);
      await fs.mkdir(aliasBin);
      // The fallback bounds this regression even on the vulnerable implementation.
      await fs.writeFile(
        path.join(userBin, "git"),
        `#!/bin/sh
printf x >> ${quoteCliArg(trace)}
if [ -n "$FIXTURE_GIT_ACTIVE" ]; then exec /usr/bin/git "$@"; fi
export FIXTURE_GIT_ACTIVE=1
git "$@"
`,
        { mode: 0o755 },
      );
      await fs.symlink(path.join(userBin, "git"), path.join(aliasBin, "git"));
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, PATH: `${aliasBin}:${userBin}:/usr/bin:/bin` },
        () => withSourceCliParent(fixture, prepareGatewayAgentCliShim),
      );
      const shim = path.join(stateDir, "tmp", "agent-git", "git");
      const env = { ...process.env, PATH: `${path.dirname(shim)}:${userBin}:/usr/bin:/bin` };
      const version = spawnSync(shim, ["--version"], { env, encoding: "utf8" });
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout).toMatch(/^git version /);
      await expect(fs.stat(trace)).rejects.toMatchObject({ code: "ENOENT" });
      const nested = spawnSync(
        shim,
        ["-c", `alias.reenter=!${quoteCliArg(shim)} --version`, "reenter"],
        { env, encoding: "utf8" },
      );
      expect(nested.status, nested.stderr).toBe(0);
      expect(nested.stdout).toMatch(/^git version /);
      const forwarded = spawnSync(path.join(userBin, "git"), ["--version"], {
        env,
        encoding: "utf8",
      });
      expect(forwarded.status, forwarded.stderr).toBe(0);
      expect(forwarded.stdout).toMatch(/^git version /);
      expect(await fs.readFile(trace, "utf8")).toBe("x");
    }),
);

it.skipIf(process.platform === "win32")(
  "survives native Git replacement and recovers a missing prepared path without re-preparation",
  () =>
    withTempDir("agent-git-upgrade-", async (root) => {
      const fixture = await createSourceCliFixture(root);
      const stateDir = path.join(root, "state");
      const stableBin = path.join(root, "stable '$` bin");
      const replacementBin = path.join(root, "replacement");
      const versions = [path.join(root, "git-v1"), path.join(root, "git-v2")];
      await fs.mkdir(stableBin);
      await fs.mkdir(replacementBin);
      const nativeGit = path.join(
        spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim(),
        "git",
      );
      for (const version of versions) {
        await fs.copyFile(nativeGit, version);
        await fs.chmod(version, 0o755);
      }
      const target = path.join(stableBin, "git");
      await fs.symlink(versions[0]!, target);
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, PATH: `${stableBin}:/usr/bin:/bin` }, () =>
        withSourceCliParent(fixture, prepareGatewayAgentCliShim),
      );
      const shim = path.join(stateDir, "tmp", "agent-git", "git");
      const env = { ...process.env, PATH: `${path.dirname(shim)}:${stableBin}:${replacementBin}` };
      const version = () => {
        const result = spawnSync(shim, ["--version"], { env, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toMatch(/^git version /);
      };
      version();
      await fs.unlink(target);
      await fs.symlink(versions[1]!, target);
      await fs.unlink(versions[0]!);
      version();
      await fs.unlink(target);
      // A forwarding fixture must not become the recovery target; remain bounded on base.
      await fs.writeFile(target, "#!/bin/sh\nexit 87\n", { mode: 0o755 });
      await fs.symlink(versions[1]!, path.join(replacementBin, "git"));
      // Move the bound path away so recovery validates the remaining PATH entries.
      await fs.rename(stableBin, `${stableBin}-retired`);
      env.PATH = `${path.dirname(shim)}:${stableBin}-retired:${replacementBin}`;
      version();
    }),
);
