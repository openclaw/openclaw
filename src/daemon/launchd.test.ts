await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));
import "./launchd-fs.mocks.test-support.js";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";
import type { PortListener } from "../infra/ports-types.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import {
  ENV,
  DOMAIN,
  SERVICE_ID,
  GUI_UNAVAILABLE,
  setLaunchAgentPlist,
  setGatewayPlist,
  launchdRestartHandoffState,
  launchdSystemState,
  cleanStaleGatewayProcessesSync,
  launchctlSpawnSync,
  inspectPortUsage,
  probePortUsage,
  formatPortDiagnostics,
  resolveGatewayServiceProbeHosts,
  setLegacyGatewayLaunchAgentPlist,
  installLaunchAgent,
  isPidDefinitelyDead,
} from "./launchd-ancestry.test-support.js";
import * as currentService from "./launchd-current-service.js";
import * as launchdExec from "./launchd-exec.js";
import {
  capturePassThroughOutput,
  createDefaultLaunchdEnv,
  createLaunchdEnvWithGatewayPort,
  defaultLaunchAgentFixture,
  launchAgentControlFixture,
  defaultProgramArguments,
} from "./launchd-install.test-support.js";
import { LAUNCH_AGENT_ENV_WRAPPER_SHELL } from "./launchd-plist.js";
import * as launchdRuntime from "./launchd-runtime.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import {
  isLaunchAgentEnabled,
  readLaunchAgentProgramArguments,
  repairLaunchAgentBootstrap,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
  startLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";

const ENV_FILE = "/Users/test/.openclaw/service-env/ai.openclaw.gateway.env";
const WRAPPER = "/Users/test/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh";
const PLIST = resolveLaunchAgentPlistPath(ENV);
const PREVIOUS_ARGS = ["/previous/node", "/previous/openclaw.mjs", "gateway"];
const WRAPPED_ARGS = [
  LAUNCH_AGENT_ENV_WRAPPER_SHELL,
  WRAPPER,
  ENV_FILE,
  ...defaultProgramArguments,
];
const BOOTSTRAP_EXISTS =
  "Could not bootstrap service: 5: Input/output error: already exists in domain for gui/501";
const BOOTSTRAP_PROGRESS = "Bootstrap failed: 37: Operation already in progress";
const { scheduleDetachedLaunchdRestartHandoff: handoff } = launchdRestartHandoffState;

function install(overrides?: Parameters<typeof defaultLaunchAgentFixture>[1]) {
  return installLaunchAgent(defaultLaunchAgentFixture(ENV, overrides));
}

function control(overrides?: Parameters<typeof launchAgentControlFixture>[1]) {
  return launchAgentControlFixture(ENV, overrides);
}

function expectCommands(commands: string) {
  expect(launchctlCommandNames()).toEqual(commands ? commands.split(" ") : []);
}

function expectProtectedCleanup(port: number) {
  expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(
    port,
    expect.objectContaining({ resolveProtectedPid: expect.any(Function) }),
  );
}

function readPlistProgramArgumentStrings(plist: string): string[] {
  const match = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i);
  return Array.from((match?.[1] ?? "").matchAll(/<string>([\s\S]*?)<\/string>/gi)).map(
    (item) => item[1] ?? "",
  );
}

function captureOutput(encoding?: BufferEncoding) {
  let output = "";
  return {
    stdout: capturePassThroughOutput((text) => (output += text), encoding),
    text: () => output,
  };
}

function mockPort(port: number, status: "free" | "busy", listeners: PortListener[] = []) {
  inspectPortUsage.mockResolvedValue({ port, status, listeners, hints: [] });
}

async function runWithFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    let settled = false;
    const pending = run()
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(
      async () => {
        await vi.runAllTimersAsync();
        expect(settled).toBe(true);
      },
      { timeout: DEFAULT_VITEST_TEST_TIMEOUT_MS - 1000 },
    );
    const result = await pending;
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  } finally {
    vi.useRealTimers();
  }
}

function launchctlCommandNames(): string[] {
  return state.launchctlCalls.map(([command]) => command ?? "");
}

function createSystemOwnershipError(status: "loaded" | "unverifiable" = "loaded"): Error {
  const details = {
    unverifiable: { operation: "launchctl", detail: "permission denied" },
    loaded: {},
  };
  return Object.assign(new Error(`system ownership blocked: ${status}`), {
    code: "SYSTEM_LAUNCH_DAEMON_OWNERSHIP",
    ownership: { status, serviceTarget: "system/ai.openclaw.gateway", ...details[status] },
  });
}

describe("launchd bootstrap repair", () => {
  it.each([
    ["loaded", "system-launchdaemon-conflict"],
    ["unverifiable", "system-launchdaemon-unverifiable"],
  ] as const)(
    "returns typed %s system ownership failures before rewriting",
    async (status, expected) => {
      launchdSystemState.assertNoSystemLaunchDaemonOwnership.mockRejectedValueOnce(
        createSystemOwnershipError(status),
      );

      const repair = await repairLaunchAgentBootstrap({ env: ENV });

      expect(repair).toEqual({
        ok: false,
        status: expected,
        detail: `system ownership blocked: ${status}`,
      });
      expect(state.fileWrites).toEqual([]);
      expect(state.launchctlCalls).toEqual([]);
    },
  );

  it("migrates inline secrets before making an existing plist readable", async () => {
    const warn = vi.fn();
    const secret = "legacy-secret";
    state.files.set(WRAPPER, "custom wrapper");
    setGatewayPlist(defaultProgramArguments, { OPENAI_API_KEY: secret });
    state.fileModes.set(PLIST, 0o600);

    await expect(repairLaunchAgentBootstrap({ env: ENV, warn })).resolves.toEqual({
      ok: true,
      status: "repaired",
    });
    expect(launchctlCommandNames()).toEqual(expect.arrayContaining(["enable", "bootstrap"]));
    expect(launchctlCommandNames().indexOf("enable")).toBeLessThan(
      launchctlCommandNames().indexOf("bootstrap"),
    );
    expect(launchctlCommandNames()).not.toContain("kickstart");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("custom behavior"));
    expect(state.files.get(PLIST)).not.toContain(secret);
    expect(state.fileModes.get(PLIST)).toBe(0o644);
    expect(state.files.get(ENV_FILE)).toContain(secret);
  });

  const repaired = { ok: true, status: "already-loaded" } as const;
  const missingDomain = "Could not find domain for user gui: 999999";
  const kickstartDenied = "launchctl kickstart failed: permission denied";
  it.each<[string, Partial<typeof state>, Awaited<ReturnType<typeof repairLaunchAgentBootstrap>>]>([
    [BOOTSTRAP_PROGRESS, { bootstrapCode: 37 }, repaired],
    [BOOTSTRAP_EXISTS, { serviceRunning: false }, repaired],
    [
      BOOTSTRAP_EXISTS,
      { bootstrapTermination: "timeout", serviceRunning: false },
      { ok: false, status: "bootstrap-failed", detail: BOOTSTRAP_EXISTS },
    ],
    [
      missingDomain,
      {},
      { ok: false, status: "gui-session-unavailable", detail: missingDomain, domain: DOMAIN },
    ],
    [
      BOOTSTRAP_PROGRESS,
      {
        bootstrapCode: 37,
        serviceRunning: false,
        kickstartError: kickstartDenied,
        kickstartFailuresRemaining: 1,
      },
      { ok: false, status: "kickstart-failed", detail: kickstartDenied },
    ],
  ])("classifies repair result for %s (%j)", async (detail, overrides, expected) => {
    Object.assign(state, { bootstrapError: detail }, overrides);
    const needsKickstart = !state.serviceRunning && state.bootstrapTermination === "exit";
    await expect(repairLaunchAgentBootstrap({ env: ENV })).resolves.toEqual(expected);
    expect(state.launchctlCalls.filter((call) => call[0] === "kickstart")).toEqual(
      needsKickstart ? [["kickstart", SERVICE_ID]] : [],
    );
  });
});

describe("launchd uninstall", () => {
  it.each([
    { operation: "lstat", code: "EACCES" },
    { operation: "rename", code: "ENOENT" },
  ] as const)(
    "reports $operation $code without leaking the plist path",
    async ({ operation, code }) => {
      if (operation === "rename") {
        state.files.set(PLIST, "RunAtLoad=true");
      }
      vi.mocked(fs[operation]).mockRejectedValueOnce(
        Object.assign(new Error(`${code}: ${operation} '${PLIST}'`), { code }),
      );
      const uninstall = uninstallLaunchAgent(control());
      await expect(uninstall).rejects.toThrow(`LaunchAgent removal failed (${code})`);
      await expect(uninstall).rejects.not.toThrow(PLIST);
      if (operation === "rename") {
        expect(state.files.has(PLIST)).toBe(true);
      }
    },
  );

  it("preserves the plist when launchctl cannot boot out the service", async () => {
    state.files.set(PLIST, "RunAtLoad=true");
    state.bootoutError = "launchctl bootout permission denied";

    await expect(uninstallLaunchAgent(control())).rejects.toThrow(
      "launchctl bootout failed: launchctl bootout permission denied",
    );
    expect(state.files.has(PLIST)).toBe(true);
  });

  it.each(["missing", "stopped symlink", "concurrently removed"])(
    "keeps removal idempotent for a %s LaunchAgent",
    async (kind) => {
      if (kind !== "missing") {
        state.files.set(PLIST, "RunAtLoad=true");
      }
      if (kind === "stopped symlink") {
        state.serviceLoaded = false;
        state.bootoutError = "Boot-out failed: 5: Input/output error";
      }
      if (kind === "concurrently removed") {
        vi.mocked(fs.rename).mockImplementationOnce(async () => {
          state.files.delete(PLIST);
          throw Object.assign(new Error(`ENOENT: no such file, rename '${PLIST}'`), {
            code: "ENOENT",
          });
        });
      }
      await expect(uninstallLaunchAgent(control())).resolves.toBeUndefined();
      expect(state.files.has(PLIST)).toBe(false);
      if (kind === "stopped symlink") {
        expect(state.launchctlCalls.some((call) => call[0] === "bootout")).toBe(false);
      }
    },
  );
});

describe("launchd install", () => {
  it("aborts before mutation with ambiguous supervision", async () => {
    const previous = setGatewayPlist(PREVIOUS_ARGS);
    state.printError = "launchctl print permission denied";
    state.printFailuresRemaining = 2;

    await expect(install()).rejects.toMatchObject({ reason: "service-membership-unverified" });

    expect(state.files.get(PLIST)).toBe(previous);
    expect(state.fileWrites).toEqual([]);
    expectCommands("print");
  });

  it.each(["fresh install", "deleted plist"])(
    "restores absent artifacts after failed activation (%s)",
    async (scenario) => {
      state.serviceLoaded = false;
      state.serviceRunning = false;
      if (scenario === "deleted plist") {
        state.serviceStates.set(SERVICE_ID, "running");
      } else {
        state.bootoutError = "Boot-out failed: 5: Input/output error";
        state.bootoutCode = 5;
      }
      state.bootstrapError = "Operation not permitted";
      state.bootstrapTransient = true;
      const operation = install({ environment: { OPENCLAW_GATEWAY_PORT: "19000" } });
      await expect(operation).rejects.toThrow(
        "launchctl bootstrap failed: Operation not permitted",
      );
      for (const path of [PLIST, ENV_FILE, WRAPPER]) {
        expect(state.files.has(path)).toBe(false);
      }
      expect(state).toMatchObject({ serviceLoaded: false, serviceRunning: false });
    },
  );

  it("fails closed when rollback cannot determine the replacement state", async () => {
    // Membership and the prior snapshot see absence; rollback sees the error.
    state.printNotLoadedRemaining = 2;
    state.printError = "launchctl print permission denied";
    state.printFailuresRemaining = 1;
    state.bootstrapError = "Operation not permitted";

    const error = await install().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("launchctl bootstrap failed: Operation not permitted"),
      }),
      expect.objectContaining({ message: expect.stringContaining("could not determine whether") }),
    ]);
    expect(state.files.has(PLIST)).toBe(true);
  });

  it.each([true, false])(
    "preserves policy and supervision after bootstrap failure (enabled=%s)",
    async (enabled) => {
      const previous = setGatewayPlist(PREVIOUS_ARGS);
      state.fileModes.set(PLIST, 0o600);
      if (!enabled) {
        state.printDisabledOutput = 'disabled services = {\n\t"ai.openclaw.gateway" => disabled\n}';
      }
      state.bootstrapError = "injected activation failure";
      state.bootstrapTransient = true;
      const operation = install({ preserveAutoStart: true });
      await expect(operation).rejects.toThrow("injected activation failure");
      expect(state.files.get(PLIST)).toBe(previous);
      expect(state).toMatchObject({ serviceLoaded: true, serviceRunning: true });
      expect(await isLaunchAgentEnabled({ env: ENV })).toBe(enabled);
    },
  );
  it.each(["install", "restart"] as const)(
    "refuses %s before user LaunchAgent mutation when a system daemon owns it",
    async (action) => {
      launchdSystemState.assertNoSystemLaunchDaemonOwnership.mockRejectedValue(
        createSystemOwnershipError(),
      );
      const args = defaultLaunchAgentFixture(ENV);
      const operations = {
        install: installLaunchAgent,
        restart: restartLaunchAgent,
      };
      await expect(operations[action](args)).rejects.toThrow("system ownership blocked: loaded");
      expect(state.fileWrites).toEqual([]);
      expect(launchctlCommandNames()).toEqual(action === "install" ? ["print", "print"] : []);
      expect(handoff).not.toHaveBeenCalled();
    },
  );

  it("keeps loaded reinstall deactivation failures fatal", async () => {
    setGatewayPlist();
    state.bootoutError = "Boot-out failed: 5: Input/output error";
    state.bootoutCode = 5;

    await expect(install()).rejects.toThrow(
      "launchctl bootout failed: Boot-out failed: 5: Input/output error",
    );
  });

  it("writes LaunchAgent environment to an owner-only env file when provided", async () => {
    const tmpDir = "/Users/test/.openclaw/tmp";
    const apiKey = "secret-api-key";
    await install({
      environment: { TMPDIR: tmpDir, OPENAI_API_KEY: apiKey, NODE_OPTIONS: "", UNUSED: "" },
    });

    const plist = state.files.get(PLIST) ?? "";
    expect(plist).not.toContain("<key>EnvironmentVariables</key>");
    expect(plist).not.toContain(apiKey);
    expect(readPlistProgramArgumentStrings(plist)).toEqual(WRAPPED_ARGS);
    const envFile = state.files.get(ENV_FILE) ?? "";
    expect(envFile).toContain(`export TMPDIR='${tmpDir}'`);
    expect(state.dirs.has(tmpDir)).toBe(true);
    expect(state.dirModes.get(tmpDir)).toBe(0o700);
    expect(plist).toContain("<key>Umask</key>\n    <integer>63</integer>");
    expect(envFile).toContain(`export OPENAI_API_KEY='${apiKey}'`);
    expect(envFile).toContain("export NODE_OPTIONS=''");
    expect(envFile).not.toContain("UNUSED");
    expect(state.fileModes.get(ENV_FILE)).toBe(0o600);
    expect(state.fileModes.get(WRAPPER)).toBe(0o700);
    expect(state.dirModes.get("/Users/test/.openclaw/service-env")).toBe(0o700);

    const command = await readLaunchAgentProgramArguments(ENV);
    expect(command).toMatchObject({
      programArguments: defaultProgramArguments,
      environment: { TMPDIR: tmpDir, OPENAI_API_KEY: apiKey, NODE_OPTIONS: "" },
      environmentValueSources: { TMPDIR: "file", OPENAI_API_KEY: "file" },
    });
  });

  it("warns before overwriting a customized generated LaunchAgent env wrapper during restart rewrite", async () => {
    await install({ environment: { OPENCLAW_GATEWAY_PORT: "18789" } });
    const generatedWrapper = expectDefined(state.files.get(WRAPPER), "generated wrapper");
    state.files.set(
      WRAPPER,
      generatedWrapper.replace('exec "$@"', 'echo "custom-secret-provider-marker"\nexec "$@"'),
    );
    const { stdout, text } = captureOutput("utf8");

    await restartLaunchAgent({ env: ENV, stdout });

    expect(text()).toContain("Warning:");
    expect(text()).toContain("contains custom behavior and will be overwritten");
    expect(text()).toContain("openclaw gateway install --wrapper <path>");
    expect(text()).toContain("OPENCLAW_WRAPPER");
    expect(state.files.get(WRAPPER)).toBe(generatedWrapper);
  });

  it.each(["legacy shell", "mangled paths"] as const)(
    "repairs generated environment wrappers on restart: %s",
    async (kind) => {
      const mangled = kind === "mangled paths";
      const callerEnv = createDefaultLaunchdEnv();
      const stateDir = "/Users/test/service-env/custom-state";
      const environment = {
        OPENCLAW_GATEWAY_PORT: mangled ? "18789" : "19007",
        ...(mangled ? { OPENCLAW_STATE_DIR: stateDir } : {}),
      };
      const serviceEnv = mangled ? { ...callerEnv, OPENCLAW_STATE_DIR: stateDir } : callerEnv;
      await installLaunchAgent(defaultLaunchAgentFixture(serviceEnv, { environment }));
      const artifactDir = mangled ? `${stateDir}/service-env` : "/Users/test/.openclaw/service-env";
      const envFilePath = `${artifactDir}/ai.openclaw.gateway.env`;
      const wrapperPath = `${artifactDir}/ai.openclaw.gateway-env-wrapper.sh`;
      const mangle = (name: string) => `${artifactDir}/[${name}](http:/${name})`;
      const badEnvFile = mangle("ai.openclaw.gateway.env");
      const badWrapper = mangle("ai.openclaw.gateway-env-wrapper.sh");
      const original = state.files.get(PLIST) ?? "";
      const broken = mangled
        ? original.replace(wrapperPath, badWrapper).replace(envFilePath, badEnvFile)
        : original.replace(`<string>${LAUNCH_AGENT_ENV_WRAPPER_SHELL}</string>\n      `, "");
      state.files.set(PLIST, broken);
      await restartLaunchAgent(launchAgentControlFixture(callerEnv));
      const rewritten = state.files.get(PLIST) ?? "";
      expect(readPlistProgramArgumentStrings(rewritten)).toEqual(WRAPPED_ARGS);
      if (mangled) {
        expect(rewritten).not.toContain(badEnvFile);
        expect(rewritten).not.toContain(badWrapper);
        const rewrittenEnv = state.files.get(ENV_FILE) ?? "";
        expect(rewrittenEnv).toContain("export OPENCLAW_GATEWAY_PORT='18789'");
        expect(rewrittenEnv).toContain(`export OPENCLAW_STATE_DIR='${stateDir}'`);
      } else {
        expectProtectedCleanup(19007);
      }
    },
  );

  it("publishes the rewritten plist before restart bootstrap", async () => {
    state.serviceLoaded = false;
    setLegacyGatewayLaunchAgentPlist(PLIST, [
      "    <key>EnvironmentVariables</key>",
      "    <dict>",
      "      <key>OPENCLAW_SERVICE_VERSION</key>",
      "      <string>2026.4.24</string>",
      "    </dict>",
    ]);

    const execLaunchctl = launchdExec.execLaunchctl;
    using launchctl = vi.spyOn(launchdExec, "execLaunchctl");
    let plist: string | undefined;
    launchctl.mockImplementation(async (...args) => {
      if (args[0][0] === "bootstrap") {
        plist = await fs.readFile(expectDefined(args[0][2], "bootstrap plist path"), "utf8");
      }
      return await execLaunchctl(...args);
    });
    await restartLaunchAgent(control());

    const logPath = "/Users/test/Library/Logs/openclaw/gateway.log";
    expect(plist).toContain("<key>StandardInPath</key>");
    expect(plist).toContain(`<key>StandardOutPath</key>\n    <string>${logPath}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n    <string>${logPath}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plist).toContain("<string>node</string>");
    expect(plist).not.toContain("OPENCLAW_SERVICE_VERSION");
  });

  it("tightens writable parents without widening private directories", async () => {
    state.dirs.add("/Users/test");
    state.dirModes.set("/Users/test", 0o777);
    state.dirs.add("/Users/test/Library");
    state.dirModes.set("/Users/test/Library", 0o700);
    await install();
    expect(state.dirModes.get("/Users/test")).toBe(0o755);
    expect(state.dirModes.get("/Users/test/Library")).toBe(0o700);
    expect(state.dirModes.get("/Users/test/Library/LaunchAgents")).toBe(0o755 & ~process.umask());
    expect(state.fileModes.get(resolveLaunchAgentPlistPath(ENV))).toBe(0o644);
  });

  it.each([
    ["loaded without a PID", true, false],
    ["unloaded with original PID alive", false, true],
  ] as const)("rejects stop success when %s", async (_name, loaded, running) => {
    const { stdout, text } = captureOutput();
    state.bootoutLeavesLoaded = loaded;
    state.serviceRunning = running;
    isPidDefinitelyDead.mockReturnValue(!running);

    await expect(runWithFakeTimers(() => stopLaunchAgent({ env: ENV, stdout }))).rejects.toThrow(
      "launchctl bootout gui/",
    );
    expect(text()).not.toContain("Stopped LaunchAgent");
    expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
  });

  it("refuses verified stop when launchd reports running without a PID", async () => {
    state.printOutput = "state = running\n";
    await expect(stopLaunchAgent(control())).rejects.toMatchObject({
      reason: "service-membership-unverified",
    });
  });

  it("waits for both asynchronous label teardown and process exit", async () => {
    vi.useFakeTimers();
    const { stdout, text } = captureOutput();
    state.bootoutLeavesLoaded = true;
    isPidDefinitelyDead.mockReturnValue(false);
    try {
      const stopped = stopLaunchAgent({ env: createDefaultLaunchdEnv(), stdout });
      await vi.advanceTimersByTimeAsync(500);
      expect(text()).not.toContain("Stopped LaunchAgent");
      state.serviceLoaded = false;
      await vi.advanceTimersByTimeAsync(500);
      expect(text()).not.toContain("Stopped LaunchAgent");
      isPidDefinitelyDead.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(500);
      await stopped;
      expect(text()).toContain("Stopped LaunchAgent");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["free", "busy"] as const)(
    "verifies the configured non-loopback host before reporting stop success (initially %s)",
    async (portStatus) => {
      const env = createLaunchdEnvWithGatewayPort("19011");
      resolveGatewayServiceProbeHosts.mockResolvedValue(["192.0.2.40"]);
      inspectPortUsage.mockResolvedValueOnce({
        port: 19011,
        status: portStatus,
        listeners: [],
        hints: [],
      });

      probePortUsage.mockResolvedValueOnce("busy").mockResolvedValueOnce("unknown");
      const { stdout, text } = captureOutput();
      await runWithFakeTimers(() => stopLaunchAgent({ env, stdout }));
      expect(inspectPortUsage).toHaveBeenCalledWith(19011, { probeHosts: ["192.0.2.40"] });
      if (portStatus === "busy") {
        expect(probePortUsage).toHaveBeenCalledWith(19011, ["192.0.2.40"]);
      } else {
        expect(probePortUsage).not.toHaveBeenCalled();
      }
      expect(text()).toContain("Stopped LaunchAgent");
    },
  );

  it("rejects stop success when disable fails and the gateway port stays busy", async () => {
    const port = 19008;
    const env = createLaunchdEnvWithGatewayPort(String(port));
    const { stdout, text } = captureOutput();
    const onMutation = vi.fn();
    state.disableError = "Operation not permitted";
    mockPort(port, "busy");
    probePortUsage.mockResolvedValue("busy");
    formatPortDiagnostics.mockReturnValue([`Port ${port} is held by pid 4242.`]);

    await expect(
      runWithFakeTimers(() => stopLaunchAgent({ env, stdout, disable: true, onMutation })),
    ).rejects.toThrow(
      `gateway port ${port} is still busy after LaunchAgent stop\nPort ${port} is held by pid 4242.`,
    );

    expect(onMutation).toHaveBeenCalledWith({ mode: "disable-bootout" });
    expect(text()).toContain("used bootout fallback");
    expect(text()).not.toContain("Stopped LaunchAgent");
  });

  it("keeps an already-unloaded service disabled when --disable is passed", async () => {
    state.serviceLoaded = false;
    state.serviceRunning = false;
    await stopLaunchAgent(control({ disable: true }));
    expect(state.serviceLoaded).toBe(false);
    expect(state.printDisabledOutput).toContain('"ai.openclaw.gateway" => disabled');
  });

  it("audits persisted disable when bootout fails", async () => {
    const onMutation = vi.fn();
    state.bootoutError = "bootout failed";
    await expect(stopLaunchAgent(control({ disable: true, onMutation }))).rejects.toThrow(
      "launchctl bootout failed",
    );
    expect(onMutation).toHaveBeenCalledWith({ mode: "disable" });
    expect(onMutation).not.toHaveBeenCalledWith({ mode: "disable-bootout" });
  });

  it("sanitizes launchctl details before writing warnings (--disable)", async () => {
    const { stdout, text } = captureOutput();
    state.disableError = "boom\n\u001b[31mred\u001b[0m\tmsg";

    await stopLaunchAgent({ env: ENV, stdout, disable: true });

    expect(text()).not.toContain("\u001b[31m");
    expect(text()).not.toContain("\nred\n");
    expect(text()).toContain("boom red msg");
    expect(state.serviceLoaded).toBe(false);
    expect(text()).toContain("Stopped LaunchAgent (degraded)");
  });

  it("starts a loaded LaunchAgent and audits before output", async () => {
    const write = vi.fn();
    const onMutation = vi.fn(({ mode }: { mode: string }) => {
      if (mode === "kickstart") {
        throw new Error("audit failed");
      }
    });

    await expect(
      startLaunchAgent({
        env: ENV,
        stdout: { write } as unknown as NodeJS.WritableStream,
        onMutation,
      }),
    ).resolves.toBeUndefined();

    expect(onMutation.mock.calls).toEqual([[{ mode: "enable" }], [{ mode: "kickstart" }]]);
    expect(
      expectDefined(onMutation.mock.invocationCallOrder[1], "kickstart audit call order"),
    ).toBeLessThan(expectDefined(write.mock.invocationCallOrder[0], "start output call order"));
  });

  it.each(["start", "restart"] as const)(
    "fails already-loaded %s bootstrap immediately instead of waiting for teardown",
    async (action) => {
      const env = action === "restart" ? createLaunchdEnvWithGatewayPort("18789") : ENV;
      const onMutation = vi.fn();
      if (action === "restart") {
        setLaunchAgentPlist(env, "ai.openclaw.gateway", ["node", "gateway.js"]);
        state.bootstrapLoadsServiceOnFailure = true;
      } else {
        state.kickstartError = "Could not find service";
        state.kickstartFailuresRemaining = 1;
      }
      state.bootstrapError = BOOTSTRAP_EXISTS;
      state.bootstrapCode = 5;
      // Real timers expose an accidental teardown retry; this job is still registered.
      const activate = action === "start" ? startLaunchAgent : restartLaunchAgent;
      const result = activate(launchAgentControlFixture(env, { onMutation }));
      await expect(result).rejects.toThrow(
        "launchctl bootstrap failed: Could not bootstrap service: 5: Input/output error",
      );
      expect(state.launchctlCalls.filter(([command]) => command === "bootstrap")).toHaveLength(1);
      if (action === "start") {
        expect(onMutation).not.toHaveBeenCalledWith({ mode: "bootstrap" });
      } else {
        await expect(result).rejects.not.toThrow("is not loaded");
      }
    },
  );

  it("audits kickstart before a later output failure", async () => {
    const env = createLaunchdEnvWithGatewayPort("18789");
    const onMutation = vi.fn();
    const stdout = {
      write: vi.fn(() => {
        throw new Error("output failed");
      }),
    } as unknown as NodeJS.WritableStream;

    await expect(restartLaunchAgent({ env, stdout, onMutation })).rejects.toThrow("output failed");

    expect(onMutation.mock.calls).toEqual([[{ mode: "enable" }], [{ mode: "kickstart" }]]);
  });

  it.each([
    { scenario: "teardown", termination: "exit" },
    { scenario: "teardown", termination: "timeout" },
    { scenario: "in-progress", termination: "exit" },
    { scenario: "in-progress", termination: "timeout" },
  ] as const)(
    "accepts $scenario bootstrap output only after a completed command ($termination)",
    async ({ scenario, termination }) => {
      const env = createLaunchdEnvWithGatewayPort("18789");
      const detail =
        scenario === "teardown" ? "Bootstrap failed: 5: Input/output error" : BOOTSTRAP_PROGRESS;
      state.bootstrapError = detail;
      if (scenario === "teardown") {
        setLaunchAgentPlist(env, "ai.openclaw.gateway", ["node", "gateway.js"]);
        state.bootstrapTransient = true;
      } else {
        setLegacyGatewayLaunchAgentPlist(resolveLaunchAgentPlistPath(env), [
          "    <key>StandardOutPath</key>",
          "    <string>/Users/test/.openclaw-default/logs/gateway.log</string>",
        ]);
        state.bootstrapLoadsServiceOnFailure = true;
      }
      state.bootstrapCode = termination === "exit" ? 5 : 1;
      state.bootstrapTermination = termination;
      const onMutation = vi.fn();

      const restart = () => restartLaunchAgent(launchAgentControlFixture(env, { onMutation }));
      const result = scenario === "teardown" ? runWithFakeTimers(restart) : restart();

      if (termination === "exit") {
        await expect(result).resolves.toEqual({ outcome: "completed" });
      } else {
        await expect(result).rejects.toThrow(`launchctl bootstrap failed: ${detail}`);
      }
      // Recovery can restore the job after interruption, but must not turn the
      // failed restart into success by treating partial EIO output as a retry.
      expect(state.serviceLoaded).toBe(true);
      if (scenario === "teardown" || termination === "exit") {
        expect(onMutation).toHaveBeenCalledWith({ mode: "bootstrap" });
      } else {
        expect(onMutation).not.toHaveBeenCalledWith({ mode: "bootstrap" });
      }
    },
  );

  it("reports the LaunchAgent as unloaded when bootstrap teardown never clears", async () => {
    const env = createLaunchdEnvWithGatewayPort("18789");
    setLaunchAgentPlist(env, "ai.openclaw.gateway", ["node", "gateway.js"]);
    // EIO that never clears must stay bounded instead of retrying forever, and
    // the restore attempt fails with it, so the label really does stay absent.
    state.bootstrapError = "Bootstrap failed: 5: Input/output error";
    state.bootstrapCode = 5;

    const error = await runWithFakeTimers(() =>
      restartLaunchAgent(launchAgentControlFixture(env)),
    ).catch((caught: unknown) => caught);

    // bootout already removed the job, so the operator has to learn both why the
    // bootstrap failed and that nothing is left for KeepAlive to respawn.
    expect(state.serviceLoaded).toBe(false);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(
      "launchctl bootstrap failed: Bootstrap failed: 5: Input/output error",
    );
    expect(message).toContain(`LaunchAgent ${DOMAIN}/ai.openclaw.gateway is not loaded`);
    expect(message).toContain("The gateway is down and launchd has no job left to respawn it.");
    expect(message).toContain("openclaw gateway start");
  });

  it("protects the current launchd PID across dual-stack listeners", async () => {
    const managedPidAfterCleanup = 4343;
    const listeners = [
      { pid: 4343, address: "TCP 127.0.0.1:19002 (LISTEN)" },
      { pid: 4343, address: "TCP [::1]:19002 (LISTEN)" },
    ];
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    const env = createLaunchdEnvWithGatewayPort("19002");
    state.printOutput = ["state = running", `pid = ${managedPidAfterCleanup}`].join("\n");
    mockPort(19002, "busy", listeners);

    const result = await restartLaunchAgent(launchAgentControlFixture(env));

    expect(result).toEqual({ outcome: "completed" });
    expectProtectedCleanup(19002);
    expect(state.cleanupProtectedPids).toEqual([managedPidAfterCleanup]);
    expect(launchctlSpawnSync).toHaveBeenCalledWith(
      "launchctl",
      ["print", SERVICE_ID],
      expect.objectContaining({
        env: expect.not.objectContaining({ BOUNDARY_PARENT_ONLY: "synthetic" }),
        timeout: 2_000,
      }),
    );
  });

  it("rejects mixed gateway port ownership before mutating launchd", async () => {
    const env = createLaunchdEnvWithGatewayPort("19002");
    setLaunchAgentPlist(env, "ai.openclaw.gateway", ["node", "gateway.js"]);
    const plistPath = resolveLaunchAgentPlistPath(env);
    const originalPlist = state.files.get(plistPath);
    inspectPortUsage.mockResolvedValue({
      port: 19002,
      status: "busy",
      listeners: [
        { pid: 4242, address: "TCP 127.0.0.1:19002 (LISTEN)" },
        { pid: 5151, address: "TCP [::1]:19002 (LISTEN)" },
      ],
      hints: ["Another process is listening on this port."],
    });
    formatPortDiagnostics.mockReturnValue(["Port 19002 is already in use."]);

    await expect(restartLaunchAgent(launchAgentControlFixture(env))).rejects.toThrow(
      "gateway port 19002 is busy but is not verifiably owned by LaunchAgent ai.openclaw.gateway",
    );

    expectProtectedCleanup(19002);
    expect(state.cleanupProtectedPids).toEqual([4242]);
    expectCommands("print print print");
    expect(state.files.get(plistPath)).toBe(originalPlist);
    expect(state.fileWrites).toHaveLength(0);
  });

  it.each([
    ["start", "stopped", "", true],
    ["start", "bootstrap-kickstart", "Could not find service", true],
    ["restart", "loaded", "", true],
    ["restart", "stopped", "", true],
    ["restart", "stopped", "Input/output error", false],
  ] as const)(
    "settles %s after kickstart failure (%s, %s, preserve=%s)",
    async (action, phase, detail, preserveDefinition) => {
      if (phase !== "loaded") {
        await stopLaunchAgent(control());
        expect(state.serviceLoaded).toBe(false);
      }
      state.kickstartError = detail;
      state.kickstartFailuresRemaining = phase === "bootstrap-kickstart" ? 2 : 1;
      state.kickstartUnloadsService = phase === "bootstrap-kickstart";
      const activate = action === "start" ? startLaunchAgent : restartLaunchAgent;
      const result = activate(control({ preserveDefinition }));
      if (phase === "stopped") {
        await expect(result).resolves.toEqual(
          action === "start" ? undefined : { outcome: "completed" },
        );
        expect(state.serviceRunning).toBe(true);
      } else {
        await expect(result).rejects.toThrow(
          /launchctl kickstart failed:[\s\S]*LaunchAgent .* is loaded; launchd can retry/,
        );
        await expect(result).rejects.toThrow(`launchctl kickstart failed: ${detail}`.trim());
      }
      expect(state.serviceLoaded).toBe(true);
      expect(launchctlCommandNames().includes("bootstrap")).toBe(phase !== "loaded");
    },
  );

  it("shows actionable guidance when launchctl gui domain does not support bootstrap", async () => {
    state.bootstrapError = GUI_UNAVAILABLE;
    const installing = install();
    await expect(installing).rejects.toThrow("logged-in macOS GUI session");
    await expect(installing).rejects.toThrow("wrong user (including sudo)");
    await expect(installing).rejects.toThrow("https://docs.openclaw.ai/gateway");
  });
});

describe("retained LaunchAgent policy", () => {
  beforeEach(() => {
    vi.spyOn(currentService, "isCurrentProcessInsideLaunchdService").mockResolvedValue(false);
    vi.spyOn(launchdRuntime, "resolveLaunchAgentGatewayContext").mockImplementation(
      async (env) => ({
        env,
        port: null,
        probeHosts: [],
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(
    ["loaded", "not-loaded", "bootstrap-failure"].flatMap((scenario) =>
      [true, false].map((preserveAutoStart) => ({ scenario, preserveAutoStart })),
    ),
  )(
    "retains launchd policy: $scenario preserve=$preserveAutoStart",
    async ({ scenario, preserveAutoStart }) => {
      Object.assign(state, {
        serviceLoaded: scenario === "loaded",
        serviceRunning: false,
        kickstartFailuresRemaining: scenario === "loaded" ? 0 : 1,
        kickstartError: "Could not find service",
        bootstrapError: scenario === "bootstrap-failure" ? "fixture bootstrap failure" : "",
        bootstrapCode: 5,
        bootstrapTransient: true,
      });
      const result = restartLaunchAgent(control({ preserveDefinition: true, preserveAutoStart }));
      if (scenario === "bootstrap-failure") {
        await expect(result).rejects.toThrow("fixture bootstrap failure");
      } else {
        await expect(result).resolves.toEqual({ outcome: "completed" });
      }
      expect(state.serviceLoaded).toBe(true);
      const commands = launchctlCommandNames();
      expect(commands.includes("enable")).toBe(!preserveAutoStart);
      expect(commands).not.toContain("disable");
      expect(commands).not.toContain("bootout");
      if (scenario !== "loaded") {
        expect(commands).toContain("bootstrap");
      }
    },
  );

  it.each(
    (["start", "restart"] as const).flatMap((action) =>
      [
        "activation",
        "nested-activation",
        "restoration",
        "disabled-bootstrap",
        "disabled-restoration",
      ].map((phase) => ({ action, phase })),
    ),
  )(
    "preserves uncertain cleanup during $action $phase without further native commands",
    async ({ action, phase }) => {
      const cleanup = new CommandProcessCleanupError();
      const failure =
        phase === "nested-activation"
          ? new AggregateError([cleanup], "activation failed")
          : cleanup;
      const commandsAfterUncertainCleanup: string[] = [];
      let uncertainCleanup = false;
      let inspections = 0;
      state.kickstartError = "fixture activation failure";
      state.kickstartCode = 5;
      state.kickstartFailuresRemaining = 1;
      if (phase.startsWith("disabled-")) {
        state.printDisabledOutput = 'disabled services = {\n"ai.openclaw.gateway" => disabled\n}';
      }
      const execute = launchdExec.execLaunchctl;
      vi.spyOn(launchdExec, "execLaunchctl").mockImplementation(async (...args) => {
        const command = args[0][0];
        if (uncertainCleanup) {
          commandsAfterUncertainCleanup.push(command ?? "");
        }
        if (
          (command === "kickstart" && ["activation", "nested-activation"].includes(phase)) ||
          command === "bootstrap"
        ) {
          uncertainCleanup = true;
          throw failure;
        }
        if (command === "print") {
          state.serviceLoaded = ++inspections === 1 && phase !== "disabled-bootstrap";
          state.serviceRunning = false;
        }
        return execute(...args);
      });
      const activate = action === "start" ? startLaunchAgent : restartLaunchAgent;
      await expect(
        activate(
          control({ preserveDefinition: true, preserveAutoStart: true, assertCurrent: () => {} }),
        ),
      ).rejects.toBe(failure);
      expect(commandsAfterUncertainCleanup).toEqual([]);
    },
  );
});
