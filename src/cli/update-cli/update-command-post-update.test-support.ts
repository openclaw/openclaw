import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { quoteCmdScriptArg } from "../../daemon/cmd-argv.js";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { captureEnv } from "../../test-utils/env.js";
import { quoteCliArg } from "../quote-cli-arg.js";
import { finishUpdate } from "./update-command-post-update.js";

export const validConfigSnapshot = {
  valid: true,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

export const successfulPluginUpdate = {
  status: "ok",
  changed: false,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

export function createManagedServiceIdentityFixture(home: string) {
  const keys = [
    "HOME",
    "USERPROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_SUPERVISOR_MODE",
    ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  ];
  const env = captureEnv(keys);
  // A private HOME does not change the OS account home checked by the real service guard.
  const userInfo = vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  for (const key of keys) {
    delete process.env[key];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    home,
    restore: () => {
      userInfo.mockRestore();
      env.restore();
    },
  };
}

export async function createScriptActivationFixture({
  root,
  mode,
  body,
  intentional,
}: {
  root: string;
  mode: "npm" | "git";
  body: string;
  intentional: boolean;
}) {
  const entrypoint = path.join(root, "dist", "index.js");
  const windows = process.platform === "win32";
  const script = path.join(root, windows ? "restart.cmd" : "restart.sh");
  const activated = path.join(root, "activation-accepted");
  await fs.mkdir(path.dirname(entrypoint));
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.8.1"}');
  await fs.writeFile(
    entrypoint,
    `if (process.argv.includes("fixture-restart")) {
      require("node:fs").writeFileSync(${JSON.stringify(activated)}, "");
      ${body === "kill -TERM $$" ? 'process.kill(process.pid, "SIGTERM");' : `process.exitCode = ${body === "exit 0" ? 0 : 78};`}
    } else if (process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH) {
      require("node:fs").writeFileSync(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, ${JSON.stringify(JSON.stringify(successfulPluginUpdate))});
    }`,
  );
  const command = [process.execPath, entrypoint, "fixture-restart"]
    .map((arg) => (windows ? quoteCmdScriptArg(arg) : quoteCliArg(arg)))
    .join(" ");
  await fs.writeFile(
    script,
    windows
      ? `@echo off\r\n${command}\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\nexec ${command}\n`,
  );
  const params = {
    mutationStarted: true,
    result: {
      status: "ok",
      mode,
      root,
      before: { version: "2026.8.1", sha: "previous" },
      after: {
        version: "2026.8.1",
        sha: "updated",
        ...(mode === "git" ? { buildId: "updated-build" } : {}),
      },
      steps: [],
      durationMs: 1,
    },
    root,
    installKindChanged: false,
    configSnapshot: {
      ...validConfigSnapshot,
      path: path.join(root, "openclaw.json"),
      exists: false,
      raw: null,
      resolved: {},
    },
    requestedChannel: null,
    storedChannel: null,
    channel: mode === "git" ? "dev" : "stable",
    downgradeRisk: false,
    shouldRestart: true,
    opts: { json: true, yes: true },
    showProgress: false,
    preManagedServiceStop: {
      stopped: !intentional,
      running: false,
      inspected: true,
      runtimeInspected: true,
      serviceMutationAllowed: true,
    },
    ownedManagedUpdateEnv: { ...process.env },
    controlPlaneUpdateSentinelMeta: {},
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    packageUpdateNodeRunner: process.execPath,
    updateStepTimeoutMs: 1_000,
  } satisfies Parameters<typeof finishUpdate>[0];
  return { entrypoint, script, activated, params };
}

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];

export async function finishSuccessfulPackageSwitch(
  params: {
    previousRoot: string;
    packageRoot: string;
    restartEnvironment?: NodeJS.ProcessEnv;
    json?: boolean;
    sealed?: boolean;
    updateMode?: UpdateRunResult["mode"];
    stoppedForUpdate?: boolean;
    intentionallyStopped?: boolean;
    windowsTaskAutoStartRecovery?: NonNullable<
      FinishUpdateParams["preManagedServiceStop"]
    >["windowsTaskAutoStartRecovery"];
  } = {
    previousRoot: "/tmp/openclaw-update",
    packageRoot: "/tmp/openclaw-update",
    restartEnvironment: process.env,
  },
): Promise<void> {
  await finishUpdate({
    mutationStarted: true,
    result: {
      status: "ok",
      mode: params.updateMode ?? "npm",
      root: params.packageRoot,
      ...(params.sealed && {
        before: { version: "2026.4.23" },
        after: {
          version: "2026.4.24",
          ...(params.updateMode === "git" ? { buildId: "new-build" } : {}),
        },
      }),
      steps: [],
      durationMs: 1,
    },
    root: params.previousRoot,
    previousInstallRoot: params.previousRoot,
    installKindChanged: params.previousRoot !== params.packageRoot,
    configSnapshot: validConfigSnapshot,
    requestedChannel: null,
    storedChannel: null,
    channel: params.updateMode === "git" ? "dev" : "stable",
    downgradeRisk: true,
    shouldRestart: Boolean(params.restartEnvironment),
    opts: { json: params.json },
    showProgress: false,
    controlPlaneUpdateSentinelMeta: {},
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 1_000,
    ...(params.restartEnvironment && {
      preManagedServiceStop: {
        stopped: params.stoppedForUpdate ?? true,
        ...(params.intentionallyStopped && { running: false }),
        windowsTaskAutoStartRecovery: params.windowsTaskAutoStartRecovery,
        ...(params.sealed && {
          serviceUpdateVerdict: {
            kind: "owned",
            root: params.previousRoot,
            refreshDefinition: false,
            fingerprint: "sealed",
          },
        }),
      },
      ownedManagedUpdateEnv: params.restartEnvironment,
    }),
  } as unknown as FinishUpdateParams);
}
