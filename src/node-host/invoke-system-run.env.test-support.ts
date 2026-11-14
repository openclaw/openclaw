import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import type { handleSystemRunInvoke } from "./invoke-system-run.js";
import {
  expectOk,
  expectError,
  firstMockCall,
  type InvokeSpies,
} from "./invoke-system-run.test-support.js";

type EnvironmentFixtures = {
  runLocal: (params?: {
    command?: string[];
    env?: Record<string, string>;
    cwd?: string;
    security?: "full" | "allowlist";
    ask?: "off" | "on-miss" | "always";
    approved?: boolean;
    runCommand?: Parameters<typeof handleSystemRunInvoke>[0]["runCommand"];
  }) => Promise<InvokeSpies>;
  fixtureDir: (prefix: string) => string;
};

export function registerSystemRunEnvironmentTests({ runLocal, fixtureDir }: EnvironmentFixtures) {
  it.each([
    ["echo", "ok"],
    ["/bin/sh", "-c", "echo ok"],
  ])("preserves requested env for full/off node execution of %s", async (...command) => {
    const env = {
      SUDO_ASKPASS: "/synthetic/askpass-helper",
      NODE_OPTIONS: "--no-warnings",
      HTTPS_PROXY: "http://127.0.0.1:9",
      GIT_CONFIG_COUNT: "0",
      CUSTOM_APP_SETTING: "kept through a shell wrapper",
    };
    const { runCommand, sendInvokeResult } = await runLocal({ command, env });
    expectOk(sendInvokeResult);
    expect(firstMockCall(runCommand)[2]).toMatchObject(env);
  });

  it("does not inherit an askpass helper even under full/off node authority", async () => {
    await withEnvAsync({ SUDO_ASKPASS: "/synthetic/inherited-helper" }, async () => {
      const { runCommand, sendInvokeResult } = await runLocal({});
      expectOk(sendInvokeResult);
      expect(firstMockCall(runCommand)[2]).not.toHaveProperty("SUDO_ASKPASS");
    });
  });

  it.runIf(process.platform !== "win32").each([false, true])(
    "preserves explicit full/off PATH after login startup (empty=%s)",
    async (empty) => {
      const { runCommand } = await import("./invoke-run-command.js");
      const cwd = fixtureDir("openclaw-node-explicit-path-");
      const bin = path.join(cwd, 'bin "quoted" $(printf injected)');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "full-env-path-probe"),
        '#!/bin/sh\nprintf "tool|%s" "$PATH"',
        {
          mode: 0o755,
        },
      );
      const requestedPath = empty ? "" : bin;
      let stdout = "";
      const invoke = await runLocal({
        command: ["/bin/sh", "-lc", empty ? 'printf "empty|%s" "$PATH"' : "full-env-path-probe"],
        cwd,
        env: { PATH: requestedPath },
        runCommand: async (...args) => {
          const result = await runCommand(...args);
          stdout = result.stdout;
          return result;
        },
      });
      expectOk(invoke.sendInvokeResult);
      expect(stdout).toBe(`${empty ? "empty" : "tool"}|${requestedPath}`);
    },
  );

  it.each([
    ["allowlist", "off", false],
    ["full", "always", false],
    ["full", "off", true],
  ] as const)(
    "rejects askpass under node policy %s/%s (approved=%s)",
    async (security, ask, approved) => {
      const { runCommand, sendInvokeResult } = await runLocal({
        security,
        ask,
        approved,
        env: { SUDO_ASKPASS: "/synthetic/askpass-helper" },
      });
      expect(runCommand).not.toHaveBeenCalled();
      expectError(sendInvokeResult, "SUDO_ASKPASS");
    },
  );

  it("preserves full-mode env for shell executable commands without inline payload", async () => {
    const { runCommand, sendInvokeResult } = await runLocal({
      command: ["/bin/sh", "./script.sh"],
      env: {
        OPENCLAW_TEST: "1",
        LANG: "C",
        LC_TIME: "C",
      },
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    const passedEnv = firstMockCall(runCommand)[2];
    expect(passedEnv).toMatchObject({ LANG: "C", LC_TIME: "C", OPENCLAW_TEST: "1" });
    expectOk(sendInvokeResult);
  });
}
