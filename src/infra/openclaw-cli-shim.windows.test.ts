import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quoteCmdScriptArg } from "../daemon/cmd-argv.js";
import {
  buildWindowsCmdExeCommandLine,
  resolveTrustedWindowsCmdExe,
} from "../process/windows-command.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveCurrentOpenClawCliInvocation } from "./openclaw-cli-invocation.js";
import {
  createSourceCliFixture,
  runSourceCliProbe,
  withSourceCliParent,
} from "./openclaw-cli-invocation.test-support.js";
import {
  clearGatewayAgentCliShim,
  mergeGatewayAgentCliPath,
  prepareGatewayAgentCliShim,
} from "./openclaw-cli-shim.js";

async function sourceFixture(root: string) {
  const f = await createSourceCliFixture(root);
  function check(result: ReturnType<typeof runSourceCliProbe>, args: string[], extra = {}) {
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: "gateway",
      args,
      cwd: f.callerCwd,
      ...extra,
    });
  }
  return {
    ...f,
    check,
    async shim(env = {}) {
      const stateDir = path.join(root, "state");
      await withEnvAsync({ ...env, OPENCLAW_STATE_DIR: stateDir }, () =>
        withSourceCliParent(f, prepareGatewayAgentCliShim),
      );
      return path.join(stateDir, "tmp", "agent-cli", "openclaw.cmd");
    },
    cmd(file: string, args: string[], expansion = "on") {
      return runSourceCliProbe(
        resolveTrustedWindowsCmdExe(),
        ["/d", `/v:${expansion}`, "/s", "/c", buildWindowsCmdExeCommandLine(file, args)],
        f.callerCwd,
        { windowsVerbatimArguments: true },
      );
    },
  };
}

const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn(() => "gbk"));
const resolveWindowsOemCodePageForEncodingMock = vi.hoisted(() => vi.fn(() => 936));

vi.mock("./windows-encoding.js", async () => {
  const actual =
    await vi.importActual<typeof import("./windows-encoding.js")>("./windows-encoding.js");
  return {
    ...actual,
    resolveWindowsOemEncoding: resolveWindowsOemEncodingMock,
    resolveWindowsOemCodePageForEncoding: resolveWindowsOemCodePageForEncodingMock,
  };
});

function expectSourceCliSuccess(
  phase: string,
  result: ReturnType<typeof runSourceCliProbe>,
  fixtureRoot: string,
) {
  // Child stacks in assertion messages make Vitest parse TSX's source-map template.
  // Keep bounded child evidence separate so the launcher failure stays visible.
  console.info(
    "[source-cli-probe]",
    JSON.stringify({
      phase,
      status: result.status,
      signal: result.signal,
      error: result.error?.message.replaceAll(fixtureRoot, "<fixture>").slice(0, 2048),
      stdout: (result.stdout ?? "").replaceAll(fixtureRoot, "<fixture>").slice(0, 2048),
      stderr: (result.stderr ?? "").replaceAll(fixtureRoot, "<fixture>").slice(-4096),
    }),
  );
  expect(result.status, phase).toBe(0);
}

afterEach(clearGatewayAgentCliShim);
describe.skipIf(process.platform !== "win32")("native Windows source CLI shim", () => {
  it.each(["off", "on"])(
    "preserves source paths and caller cwd with delayed expansion %s",
    (expansion) =>
      withTempDir("openclaw-source-cli-win-", async (root) => {
        const f = await sourceFixture(root);
        const args = ["--profile", "work", "probe"];
        const shim = await f.shim({ OPENCLAW_PROFILE: "work" });
        f.check(
          f.cmd(shim, ["probe"], expansion),
          args,
          process.versions.bun ? {} : { tsconfigPath: path.join(f.checkout, "tsconfig.json") },
        );
      }),
  );

  it("preserves literal forwarded bangs and percent signs", () =>
    withTempDir("openclaw-source-cli-args-win-", async (root) => {
      const f = await sourceFixture(root);
      const shim = await f.shim();
      const caller = path.join(root, "caller.cmd");
      // Forward literal arguments from a caller with expansion disabled into an enabled shell.
      await fs.writeFile(
        caller,
        [
          "@echo off",
          "setlocal DisableDelayedExpansion",
          `${quoteCmdScriptArg(shim, { delayedExpansion: false })} probe "literal!%%USERPROFILE%%!"`,
          "",
        ].join("\r\n"),
      );
      f.check(f.cmd(caller, []), ["probe", "literal!%USERPROFILE%!"]);
    }));

  it("executes and regenerates a CJK-path launcher through cmd.exe", async () => {
    await withTempDir("openclaw-source-cli-cjk-win-", async (root) => {
      const fixture = await createSourceCliFixture(root);
      const cjkCheckout = path.join(root, "用户", "OpenClaw source");
      await fs.cp(fixture.checkout, cjkCheckout, { recursive: true });
      const cjkEntryPath = path.join(cjkCheckout, "src", "entry.ts");
      const invocation = resolveCurrentOpenClawCliInvocation([], {
        argv1: cjkEntryPath,
        cwd: fixture.callerCwd,
        execArgv: fixture.execArgv,
        execPath: process.execPath,
      });
      const stateDir = path.join(root, "state");
      const shimPath = path.join(stateDir, "tmp", "agent-cli", "openclaw.cmd");
      const command = buildWindowsCmdExeCommandLine(shimPath, ["probe"]);

      for (const regeneration of [1, 2]) {
        await prepareGatewayAgentCliShim({ env: {}, invocation, stateDir });
        const result = runSourceCliProbe(
          resolveTrustedWindowsCmdExe(),
          ["/d", "/v:off", "/s", "/c", command],
          fixture.callerCwd,
          { windowsVerbatimArguments: true },
        );
        expect(result.status, `CJK launcher regeneration ${regeneration}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          source: "gateway",
          args: ["probe"],
          cwd: fixture.callerCwd,
          tsconfigPath: path.join(cjkCheckout, "tsconfig.json"),
        });
      }
    });
  });

  it("keeps the existing launcher usable when CJK regeneration is unrepresentable", async () => {
    await withTempDir("openclaw-source-cli-existing-win-", async (root) => {
      const fixture = await createSourceCliFixture(root);
      const stateDir = path.join(root, "state");
      const shimPath = path.join(stateDir, "tmp", "agent-cli", "openclaw.cmd");
      const command = buildWindowsCmdExeCommandLine(shimPath, ["probe"]);

      await prepareGatewayAgentCliShim({ env: {}, invocation: fixture.invocation, stateDir });
      const existingLauncher = await fs.readFile(shimPath);
      const initial = runSourceCliProbe(
        resolveTrustedWindowsCmdExe(),
        ["/d", "/v:off", "/s", "/c", command],
        fixture.callerCwd,
        { windowsVerbatimArguments: true },
      );
      expect(initial.status).toBe(0);

      const cjkCheckout = path.join(root, "用户", "OpenClaw source");
      await fs.cp(fixture.checkout, cjkCheckout, { recursive: true });
      const cjkEntryPath = path.join(cjkCheckout, "src", "entry.ts");
      const cjkInvocation = resolveCurrentOpenClawCliInvocation([], {
        argv1: cjkEntryPath,
        cwd: fixture.callerCwd,
        execArgv: fixture.execArgv,
        execPath: process.execPath,
      });
      resolveWindowsOemEncodingMock.mockReturnValue("cp857");
      resolveWindowsOemCodePageForEncodingMock.mockReturnValue(857);
      const unavailableWarnings: string[] = [];
      try {
        await prepareGatewayAgentCliShim({
          env: {},
          invocation: cjkInvocation,
          onUnavailable: (error) => unavailableWarnings.push(String(error).slice(0, 512)),
          stateDir,
        });
      } finally {
        resolveWindowsOemEncodingMock.mockImplementation(() => "gbk");
        resolveWindowsOemCodePageForEncodingMock.mockImplementation(() => 936);
      }

      const preservedLauncher = await fs.readFile(shimPath);
      expect(preservedLauncher.equals(existingLauncher)).toBe(true);
      const afterFailedRegeneration = runSourceCliProbe(
        resolveTrustedWindowsCmdExe(),
        ["/d", "/v:off", "/s", "/c", command],
        fixture.callerCwd,
        { windowsVerbatimArguments: true },
      );
      expectSourceCliSuccess(
        "existing launcher after failed CJK regeneration",
        afterFailedRegeneration,
        root,
      );
      const generatedPath = mergeGatewayAgentCliPath();
      console.info(
        "[gateway-agent-cli-fallback]",
        JSON.stringify({
          phase: "existing-launcher-after-failed-regeneration",
          commandStatus: afterFailedRegeneration.status,
          launcherPreserved: preservedLauncher.equals(existingLauncher),
          generatedPathPresent: generatedPath !== undefined,
          warningReported: unavailableWarnings.length > 0,
        }),
      );
      expect(generatedPath).toBeUndefined();
      expect(unavailableWarnings).toHaveLength(1);
      expect(JSON.parse(afterFailedRegeneration.stdout)).toMatchObject({
        source: "gateway",
        args: ["probe"],
        cwd: fixture.callerCwd,
        tsconfigPath: path.join(fixture.checkout, "tsconfig.json"),
      });
    });
  });

  it.each(["generic Node host", "bare TSX source parent"])(
    "launches source mode outside the checkout from a %s",
    (parent) =>
      withTempDir("openclaw-source-cli-host-win-", async (root) => {
        const f = await sourceFixture(root);
        const modulesDir = path.join(f.checkout, "node_modules");
        await fs.mkdir(modulesDir);
        await fs.symlink(
          path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
          path.join(modulesDir, "tsx"),
          "junction",
        );
        const hostEntry = path.join(f.checkout, "scripts", "host.mjs");
        await fs.mkdir(path.dirname(hostEntry));
        await fs.writeFile(hostEntry, "// A generic Node host is not the OpenClaw CLI entry.\n");
        const sourceParent = parent === "bare TSX source parent";
        const execArgv = sourceParent ? ["--import", "tsx"] : f.execArgv;
        const invocation = withSourceCliParent(
          {
            entryPath: sourceParent ? f.entryPath : hostEntry,
            execArgv: sourceParent ? execArgv : [],
          },
          () => resolveCurrentOpenClawCliInvocation(["probe"]),
        );
        f.check(
          runSourceCliProbe(invocation.command, invocation.args, f.callerCwd, {
            env: invocation.env,
          }),
          ["probe"],
        );
      }),
  );
});
