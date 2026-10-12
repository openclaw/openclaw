/** Tests node-host system.run policy, approval, allowlist, and execution behavior. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { deleteExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import * as approvalsStore from "../infra/exec-approvals-store.test-support.js";
import type { ExecAsk, ExecSecurity, SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import {
  commitExecAuthorizationLocked,
  createExecApprovalPolicySnapshot,
  loadExecApprovals,
} from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import * as commandResolution from "../infra/exec-command-resolution.js";
import { requestExecHostViaSocket, type ExecHostResponse } from "../infra/exec-host.js";
import { formatExecCommand } from "../infra/system-run-command.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";
import { handleSystemRunInvoke } from "./invoke-system-run.js";

type InvokeOptions = Parameters<typeof handleSystemRunInvoke>[0];

vi.mock("../infra/exec-host.js", () => ({ requestExecHostViaSocket: vi.fn() }));

vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logWarn: vi.fn(),
}));

type MockedRunCommand = Mock<InvokeOptions["runCommand"]>;
type MockedRequestExecHost = Mock<typeof requestExecHostViaSocket>;
type MockedSendInvokeResult = Mock<InvokeOptions["sendInvokeResult"]>;
type MockedSendNodeEvent = Mock<NonNullable<InvokeOptions["sendNodeEvent"]>>;
type InvokeSpies = {
  runCommand: MockedRunCommand;
  requestExecHost: MockedRequestExecHost;
  sendInvokeResult: MockedSendInvokeResult;
  sendNodeEvent: MockedSendNodeEvent;
};

describe("handleSystemRunInvoke mac app exec host routing", () => {
  let sharedFixtureRoot = "";
  let sharedOpenClawHome = "";
  let sharedFixtureId = 0;
  let previousOpenClawHome: string | undefined;

  beforeAll(() => {
    closeOpenClawStateDatabaseForTest();
    sharedFixtureRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-host-fixtures-")),
    );
    sharedOpenClawHome = path.join(sharedFixtureRoot, "openclaw-home");
    fs.mkdirSync(sharedOpenClawHome, { recursive: true });
  });

  afterAll(() => {
    closeOpenClawStateDatabaseForTest();
    if (sharedFixtureRoot) {
      fs.rmSync(sharedFixtureRoot, { recursive: true, force: true });
    }
  });

  function fixtureDir(prefix: string): string {
    const dir = path.join(sharedFixtureRoot, `${prefix}${sharedFixtureId++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    previousOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = sharedOpenClawHome;
    approvalsStore.testing.reset();
    // Cases isolate the canonical policy row, not shared-state schema bootstrap.
    deleteExecApprovalsConfigRow(openOpenClawStateDatabase().db);
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    approvalsStore.testing.reset();
    clearRuntimeConfigSnapshot();
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
  });

  function localResult(stdout = "local-ok") {
    return {
      success: true,
      stdout,
      stderr: "",
      timedOut: false,
      truncated: false,
      exitCode: 0,
      error: null,
    };
  }

  function executable(dir: string, name: string): string {
    const fileName = process.platform === "win32" ? `${name}.exe` : name;
    const executablePath = path.join(dir, fileName);
    fs.writeFileSync(executablePath, "");
    fs.chmodSync(executablePath, 0o755);
    return executablePath;
  }

  function strictInlinePlan(prefix: string): SystemRunApprovalPlan {
    const tempDir = fixtureDir(prefix);
    const executablePath = executable(tempDir, "gawk");
    const scriptPath = path.join(tempDir, "library.awk");
    fs.writeFileSync(scriptPath, "{ print }\n");
    const prepared = prepareSession(
      [executablePath, "-f", scriptPath, '--source=BEGIN{print "safe"}'],
      "agent:main:main",
    );
    if (!prepared.ok) {
      throw new Error(prepared.message);
    }
    return prepared.plan;
  }

  function bindCurrentPolicyToPlan(plan: SystemRunApprovalPlan): SystemRunApprovalPlan {
    const agentId = plan.agentId ?? "main";
    return {
      ...plan,
      agentId,
      sessionKey: plan.sessionKey ?? "agent:main:main",
      policySnapshot: createExecApprovalPolicySnapshot({
        file: loadExecApprovals(),
        agentId,
      }),
    };
  }

  function requireApprovalPlan(
    prepared: ReturnType<typeof buildSystemRunApprovalPlan>,
    message: string,
  ): asserts prepared is Extract<ReturnType<typeof buildSystemRunApprovalPlan>, { ok: true }> {
    if (!prepared.ok) {
      throw new Error(message);
    }
  }

  function prepareSession(command: string[], sessionKey: string) {
    return buildSystemRunApprovalPlan({ command, sessionKey });
  }

  function prepareCwd(command: string[], cwd: string) {
    return buildSystemRunApprovalPlan({ command, cwd });
  }

  function prepareCwdSession(command: string[], cwd: string, sessionKey: string) {
    return buildSystemRunApprovalPlan({ command, cwd, sessionKey });
  }

  function expectOk(sendInvokeResult: MockedSendInvokeResult, payloadContains?: string) {
    const result = invokeResult(sendInvokeResult);
    expect(result.ok).toBe(true);
    if (payloadContains) {
      expect(result.payloadJSON).toContain(payloadContains);
    }
  }

  function expectError(
    sendInvokeResult: MockedSendInvokeResult,
    expectedMessage: string,
    exact = false,
  ) {
    const result = invokeResult(sendInvokeResult);
    expect(result.ok).toBe(false);
    const message = result.error?.message;
    if (exact) {
      expect(message).toBe(expectedMessage);
    } else {
      expect(message).toContain(expectedMessage);
    }
  }

  function firstMockCall<T extends unknown[]>(mock: { mock: { calls: T[] } }): T {
    const [call] = mock.mock.calls;
    if (!call) {
      throw new Error("Expected mock call");
    }
    return call;
  }

  function invokeResult(sendInvokeResult: MockedSendInvokeResult) {
    return firstMockCall(sendInvokeResult)[0];
  }

  function runArgv(runCommand: MockedRunCommand) {
    return firstMockCall(runCommand)[0];
  }

  function readMacCall(requestExecHost: MockedRequestExecHost) {
    return firstMockCall(requestExecHost)[0];
  }

  function expectExecDeniedEvent(
    sendNodeEvent: MockedSendNodeEvent,
    reason = "approval-required",
  ): void {
    const call = sendNodeEvent.mock.calls[0];
    if (!call) {
      throw new Error("expected sendNodeEvent call");
    }
    expect(call[0]).toBe("exec.denied");
    expect(call[1]).toMatchObject({ reason });
  }

  function expectApprovalRequired(
    sendNodeEvent: MockedSendNodeEvent,
    sendInvokeResult: MockedSendInvokeResult,
  ) {
    expectExecDeniedEvent(sendNodeEvent);
    expectError(sendInvokeResult, "SYSTEM_RUN_DENIED: approval required", true);
  }

  function expectWriteDenied(params: {
    sendNodeEvent: MockedSendNodeEvent;
    sendInvokeResult: MockedSendInvokeResult;
  }) {
    expectExecDeniedEvent(params.sendNodeEvent, "approval-state-write-failed");
    expect(invokeResult(params.sendInvokeResult)).toMatchObject({
      ok: false,
      error: {
        code: "SYSTEM_RUN_DENIED",
        message: "SYSTEM_RUN_DENIED: approval state could not be persisted",
      },
    });
  }

  function createMutableScriptOperandFixture(tmp: string): {
    command: string[];
    scriptPath: string;
    initialBody: string;
    changedBody: string;
  } {
    if (process.platform === "win32") {
      const scriptPath = path.join(tmp, "run.js");
      return {
        command: [process.execPath, "./run.js"],
        scriptPath,
        initialBody: 'console.log("SAFE");\n',
        changedBody: 'console.log("PWNED");\n',
      };
    }
    const scriptPath = path.join(tmp, "run.sh");
    return {
      command: ["/bin/sh", "./run.sh"],
      scriptPath,
      initialBody: "#!/bin/sh\necho SAFE\n",
      changedBody: "#!/bin/sh\necho PWNED\n",
    };
  }

  function createTsxScriptOperandFixture(tmp: string) {
    return {
      command: ["tsx", "./run.ts"],
      scriptPath: path.join(tmp, "run.ts"),
      initialBody: 'console.log("SAFE");\n',
      changedBody: 'console.log("PWNED");\n',
    };
  }

  function macSuccess(stdout = "app-ok"): ExecHostResponse {
    return {
      ok: true,
      payload: {
        success: true,
        stdout,
        stderr: "",
        timedOut: false,
        exitCode: 0,
        error: null,
      },
    };
  }

  function allowlistPolicy(params?: {
    autoAllowSkills?: boolean;
    agents?: Parameters<typeof approvalsStore.saveExecApprovals>[0]["agents"];
  }): Parameters<typeof approvalsStore.saveExecApprovals>[0] {
    return {
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
        ...(params?.autoAllowSkills ? { autoAllowSkills: true } : {}),
      },
      agents: params?.agents ?? {},
    };
  }

  function policy(
    security: ExecSecurity,
    ask: ExecAsk,
    askFallback: ExecSecurity,
    agents?: Parameters<typeof approvalsStore.saveExecApprovals>[0]["agents"],
  ): Parameters<typeof approvalsStore.saveExecApprovals>[0] {
    return {
      version: 1,
      defaults: { security, ask, askFallback },
      ...(agents === undefined ? {} : { agents }),
    };
  }

  function createExactCommandPattern(commandText: string): string {
    return `=command:${crypto.createHash("sha256").update(commandText).digest("hex").slice(0, 16)}`;
  }

  function durableFixture(options: { payload?: string; fallback?: boolean } = {}) {
    const tempDir = fixtureDir("openclaw-durable-");
    const prepared = prepareCwdSession(
      ["/bin/sh", "-c", options.payload ?? "/bin/ls"],
      tempDir,
      "agent:main:main",
    );
    requireApprovalPlan(prepared, "expected a bound durable command");
    const commandPattern = createExactCommandPattern(prepared.plan.commandText);
    approvalsStore.saveExecApprovals(
      policy(
        options.fallback ? "full" : "allowlist",
        options.fallback ? "always" : "on-miss",
        options.fallback ? "allowlist" : "full",
        { main: { allowlist: [{ pattern: commandPattern, source: "allow-always" }] } },
      ),
    );
    return { tempDir, prepared, commandPattern };
  }

  function createInvokeSpies(params?: {
    runCommand?: InvokeOptions["runCommand"];
    requestExecHost?: typeof requestExecHostViaSocket;
    sendInvokeResult?: InvokeOptions["sendInvokeResult"];
    sendNodeEvent?: InvokeOptions["sendNodeEvent"];
  }): InvokeSpies {
    return {
      runCommand: vi.fn(params?.runCommand ?? (async () => localResult())),
      requestExecHost: vi.fn(params?.requestExecHost ?? (async () => null)),
      sendInvokeResult: vi.fn(params?.sendInvokeResult ?? (async () => {})),
      sendNodeEvent: vi.fn(params?.sendNodeEvent ?? (async () => {})),
    };
  }

  function mutatePolicyOnCommit(
    mutate: (current: ReturnType<typeof loadExecApprovals>) => void,
  ): Mock<NonNullable<InvokeOptions["commitExecAuthorization"]>> {
    return vi.fn(async (params) => {
      const current = loadExecApprovals();
      mutate(current);
      approvalsStore.saveExecApprovals(current);
      return await commitExecAuthorizationLocked(params);
    });
  }

  async function withPathTokenCommand<T>(
    tmpPrefix: string,
    run: (ctx: { link: string; expected: string }) => Promise<T>,
  ): Promise<T> {
    const tmp = fixtureDir(tmpPrefix);
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, "poccmd");
    fs.symlinkSync("/bin/echo", link);
    const expected = fs.realpathSync(link);
    return await withEnvAsync({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }, () =>
      run({ link, expected }),
    );
  }

  async function withFakeTsxOnPath<T>(run: () => Promise<T>): Promise<T> {
    const binDir = fixtureDir("tsx-bin-");
    const runtimePath = path.join(binDir, process.platform === "win32" ? "tsx.cmd" : "tsx");
    const runtimeBody =
      process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
    fs.writeFileSync(runtimePath, runtimeBody, { mode: 0o755 });
    if (process.platform !== "win32") {
      fs.chmodSync(runtimePath, 0o755);
    }
    return await withEnvAsync({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }, run);
  }

  function expectCommandPinnedToCanonicalPath(
    runCommand: MockedRunCommand,
    expected: string,
    commandTail: string[],
    cwd?: string,
  ) {
    const params = { runCommand, expected, commandTail, cwd };
    expect(params.runCommand).toHaveBeenCalledWith(
      [params.expected, ...params.commandTail],
      params.cwd,
      expect.any(Object),
      undefined,
      undefined,
      expect.any(Function),
    );
  }

  async function runInvoke(params: {
    preferMacAppExecHost: boolean;
    runViaResponse?: ExecHostResponse | null;
    command?: string[];
    env?: Record<string, string>;
    executionContext?: InvokeOptions["params"]["executionContext"];
    rawCommand?: string | null;
    systemRunPlan?: SystemRunApprovalPlan | null;
    preparedPlan?: SystemRunApprovalPlan;
    cwd?: string;
    agentId?: string;
    security?: "full" | "allowlist";
    ask?: "off" | "on-miss" | "always";
    approvalDecision?: "allow" | "allow-once" | "allow-always" | "deny" | null;
    approvalSource?: string | null;
    approved?: boolean;
    needsScreenRecording?: boolean;
    suppressNotifyOnExit?: boolean;
    runCommand?: InvokeOptions["runCommand"];
    requestExecHost?: typeof requestExecHostViaSocket;
    sendInvokeResult?: InvokeOptions["sendInvokeResult"];
    sendNodeEvent?: InvokeOptions["sendNodeEvent"];
    skillBinsCurrent?: () => Promise<Array<{ name: string; resolvedPath: string }>>;
    autoReviewer?: ExecAutoReviewer;
    commitExecAuthorization?: InvokeOptions["commitExecAuthorization"];
    bindApproval?: boolean;
    signal?: AbortSignal;
  }): Promise<InvokeSpies> {
    const spies = createInvokeSpies({
      runCommand: params.runCommand,
      requestExecHost: params.requestExecHost ?? (async () => params.runViaResponse ?? null),
      sendInvokeResult: params.sendInvokeResult,
      sendNodeEvent: params.sendNodeEvent,
    });

    vi.mocked(requestExecHostViaSocket).mockImplementation(spies.requestExecHost);

    const command = params.command ?? params.preparedPlan?.argv ?? ["echo", "ok"];
    let dispatchCommand = command;
    let dispatchRawCommand = params.rawCommand ?? params.preparedPlan?.commandText;
    let dispatchCwd = params.cwd ?? params.preparedPlan?.cwd ?? undefined;
    let dispatchAgentId: string | undefined = params.agentId ?? "main";
    const forwardsDelayedApproval =
      params.approvalSource === "auto-review" ||
      params.approved === true ||
      params.approvalDecision === "allow" ||
      params.approvalDecision === "allow-once" ||
      params.approvalDecision === "allow-always";
    const providedPlan = params.preparedPlan ?? params.systemRunPlan ?? undefined;
    let systemRunPlan: SystemRunApprovalPlan | undefined = providedPlan
      ? {
          ...providedPlan,
          agentId: providedPlan.agentId ?? dispatchAgentId,
          sessionKey: providedPlan.sessionKey ?? "agent:main:main",
        }
      : undefined;
    if (forwardsDelayedApproval && params.bindApproval !== false) {
      if (!systemRunPlan) {
        const prepared = buildSystemRunApprovalPlan({
          command,
          rawCommand: params.rawCommand,
          cwd: params.cwd,
          agentId: dispatchAgentId,
          sessionKey: "agent:main:main",
        });
        if (!prepared.ok) {
          throw new Error(prepared.message);
        }
        systemRunPlan = prepared.plan;
        dispatchCommand = prepared.plan.argv;
        dispatchRawCommand = prepared.plan.commandText;
        dispatchCwd = prepared.plan.cwd ?? undefined;
        dispatchAgentId = prepared.plan.agentId ?? undefined;
      }
      systemRunPlan = bindCurrentPolicyToPlan(systemRunPlan);
    }

    await handleSystemRunInvoke({
      params: {
        command: dispatchCommand,
        env: params.env,
        executionContext: params.executionContext,
        rawCommand: dispatchRawCommand,
        systemRunPlan,
        cwd: dispatchCwd,
        agentId: dispatchAgentId,
        approvalDecision: params.approvalDecision,
        approvalSource: params.approvalSource,
        approved: params.approved,
        needsScreenRecording: params.needsScreenRecording,
        suppressNotifyOnExit: params.suppressNotifyOnExit,
        sessionKey: "agent:main:main",
      },
      skillBins: {
        current: params.skillBinsCurrent ?? (async () => []),
      },
      signal: params.signal,
      runCommand: spies.runCommand,
      sendInvokeResult: spies.sendInvokeResult,
      sendNodeEvent: spies.sendNodeEvent,
      preferMacAppExecHost: params.preferMacAppExecHost,
      getRuntimeConfig: () => {
        const cfg = getRuntimeConfigSnapshot() ?? {};
        return {
          ...cfg,
          tools: {
            ...cfg.tools,
            exec: {
              security: params.security ?? "full",
              ask: params.ask ?? "off",
              ...cfg.tools?.exec,
            },
          },
        };
      },
      autoReviewer: params.autoReviewer,
      commitExecAuthorization: params.commitExecAuthorization,
    });

    return spies;
  }

  type SystemInvokeFixtureParams = Parameters<typeof runInvoke>[0];

  async function runLocal(params: Omit<SystemInvokeFixtureParams, "preferMacAppExecHost"> = {}) {
    return await runInvoke({ ...params, preferMacAppExecHost: false });
  }

  async function runMac(params: Omit<SystemInvokeFixtureParams, "preferMacAppExecHost"> = {}) {
    return await runInvoke({ ...params, preferMacAppExecHost: true });
  }

  it("refuses execution context when the companion relay cannot preserve it", async () => {
    const result = await runMac({ executionContext: { subagent: true } });
    expectError(result.sendInvokeResult, "executionContext invalid or unsupported");
    expect(result.requestExecHost).not.toHaveBeenCalled();
    expect(result.runCommand).not.toHaveBeenCalled();
  });

  it("preserves a native cwd refusal without labelling it approval-required", async () => {
    const result = await runMac({
      runViaResponse: {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          reason: "cwd-unavailable",
          message: "Working directory does not exist, is inaccessible, or is not a directory.",
        },
      },
    });
    expectExecDeniedEvent(result.sendNodeEvent, "cwd-unavailable");
    expect(result.runCommand).not.toHaveBeenCalled();
  });

  it("keeps a lost companion response ambiguous", async () => {
    const result = await runMac();
    expect(result.requestExecHost).toHaveBeenCalledOnce();
    expect(result.runCommand).not.toHaveBeenCalled();
    expect(invokeResult(result.sendInvokeResult)).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
  });

  it("does not spawn an already-cancelled node command", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runLocal({ signal: controller.signal });

    expect(result.runCommand).not.toHaveBeenCalled();
    expect(result.requestExecHost).not.toHaveBeenCalled();
  });

  it("does not publish a cancelled local command completion", async () => {
    const controller = new AbortController();
    const result = await runLocal({
      signal: controller.signal,
      runCommand: async (_argv, _cwd, _env, _timeout, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        return localResult("cancelled");
      },
    });

    expect(result.runCommand).toHaveBeenCalledOnce();
    expect(result.sendInvokeResult).not.toHaveBeenCalled();
    expect(result.sendNodeEvent).not.toHaveBeenCalledWith("exec.finished", expect.anything());
  });

  it("cancels pending Mac exec without replay or publication", async () => {
    const controller = new AbortController();
    const result = await runMac({
      signal: controller.signal,
      requestExecHost: ({ signal }) => {
        expect(signal).toBe(controller.signal);
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(null), { once: true });
          queueMicrotask(() => controller.abort());
        });
      },
    });

    expect(result.requestExecHost).toHaveBeenCalledOnce();
    expect(result.runCommand).not.toHaveBeenCalled();
    expect(result.sendNodeEvent).not.toHaveBeenCalled();
    expect(result.sendInvokeResult).not.toHaveBeenCalled();
  });

  it.each(["medium"] as const)(
    "uses auto reviewer for system.run approval misses with %s risk when exec mode is auto",
    async (risk) => {
      const tmp = fixtureDir("openclaw-system-run-auto-review-");
      const executablePath = executable(tmp, "read-info");
      setRuntimeConfigSnapshot({ tools: { exec: { mode: "auto" } } });
      const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
        decision: "allow-once",
        rationale: "reads fixture metadata only",
        risk,
      }));
      const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
      const runCommand = vi.fn(async () => localResult("auto-reviewed"));
      const prepared = prepareCwd([executablePath, "security.audit.suppressions"], tmp);
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const invoke = await runLocal({
        command: prepared.plan.argv,
        cwd: prepared.plan.cwd ?? tmp,
        systemRunPlan: prepared.plan,
        runCommand,
        security: "allowlist",
        ask: "on-miss",
        autoReviewer,
        commitExecAuthorization: commitAuthorization,
      });

      expect(autoReviewer).toHaveBeenCalledTimes(1);
      expect(autoReviewer).toHaveBeenCalledWith(
        expect.objectContaining({
          command: `${executablePath} security.audit.suppressions`,
          argv: [executablePath, "security.audit.suppressions"],
          cwd: tmp,
          host: "node",
          reason: "approval-required",
          analysis: expect.objectContaining({
            parsed: true,
            allowlistMatched: false,
            inlineEval: false,
          }),
        }),
      );
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(commitAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization: expect.objectContaining({ source: "auto-review" }),
        }),
      );
      expectOk(invoke.sendInvokeResult, "auto-reviewed");

      const macInvoke = await runMac({
        runViaResponse: macSuccess(),
        command: prepared.plan.argv,
        cwd: prepared.plan.cwd ?? tmp,
        systemRunPlan: prepared.plan,
        security: "allowlist",
        ask: "on-miss",
        autoReviewer,
      });
      const macCall = readMacCall(macInvoke.requestExecHost);
      expect(macCall.request?.approvalSource).toBe("auto-review");
      expect(macCall.request?.approvalDecision).toBeNull();
      expect(macCall.request?.policySnapshot).toEqual(
        createExecApprovalPolicySnapshot({ file: loadExecApprovals(), agentId: undefined }),
      );
      expect(macInvoke.runCommand).not.toHaveBeenCalled();
      expectOk(macInvoke.sendInvokeResult, "app-ok");
    },
  );

  it("does not auto-review direct system.run approval misses without an approval plan", async () => {
    const tmp = fixtureDir("openclaw-system-run-auto-review-no-plan-");
    const executablePath = executable(tmp, "read-info");
    setRuntimeConfigSnapshot({ tools: { exec: { mode: "auto" } } });
    const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
      decision: "allow-once",
      rationale: "reads fixture metadata only",
      risk: "low",
    }));
    const runCommand = vi.fn(async () => localResult("should-not-run"));
    const invoke = await runLocal({
      command: [executablePath],
      cwd: tmp,
      runCommand,
      security: "allowlist",
      ask: "on-miss",
      autoReviewer,
    });

    expect(autoReviewer).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expectError(invoke.sendInvokeResult, "SYSTEM_RUN_DENIED: approval required");
  });

  it.runIf(process.platform !== "win32").each(["/bin/sh"])(
    "does not auto-review direct %s login-shell startup",
    async (shell) => {
      const tmp = fixtureDir("openclaw-system-run-auto-review-login-");
      setRuntimeConfigSnapshot({ tools: { exec: { mode: "auto" } } });
      const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
        decision: "allow-once",
        rationale: "unsafe startup wrapper must not reach the reviewer",
        risk: "low",
      }));
      const loginCommand = `${shell} -lc "echo auto-review-startup-proof"`;
      const command = ["/bin/sh", "-lc", loginCommand];
      // The real plan builder already rejects this wrapper. Exercise the
      // node trust boundary against a hostile, otherwise well-formed plan.
      const approvalPlan = {
        argv: command,
        cwd: tmp,
        commandText: formatExecCommand(command),
        agentId: "main",
        sessionKey: "agent:main:main",
      } satisfies SystemRunApprovalPlan;

      const invoke = await runLocal({
        command,
        rawCommand: approvalPlan.commandText,
        cwd: tmp,
        systemRunPlan: approvalPlan,
        security: "allowlist",
        ask: "on-miss",
        autoReviewer,
      });

      expect(autoReviewer).not.toHaveBeenCalled();
      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectError(invoke.sendInvokeResult, "SYSTEM_RUN_DENIED: approval required");
    },
  );

  it.each(["ask", "deny"] as const)(
    "does not execute when system.run auto reviewer returns %s",
    async (decision) => {
      const tmp = fixtureDir("openclaw-system-run-auto-review-ask-");
      const executablePath = executable(tmp, "read-info");
      setRuntimeConfigSnapshot({ tools: { exec: { mode: "auto" } } });
      const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
        decision,
        rationale: "needs a person",
        risk: "medium",
      }));
      const runCommand = vi.fn(async () => localResult("should-not-run"));
      const prepared = prepareCwd([executablePath], tmp);
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const invoke = await runLocal({
        command: prepared.plan.argv,
        cwd: prepared.plan.cwd ?? tmp,
        systemRunPlan: prepared.plan,
        runCommand,
        security: "allowlist",
        ask: "on-miss",
        autoReviewer,
      });

      expect(autoReviewer).toHaveBeenCalledTimes(1);
      expect(runCommand).not.toHaveBeenCalled();
      if (decision === "deny") {
        expect(invokeResult(invoke.sendInvokeResult)).toEqual({
          ok: false,
          error: {
            code: "SYSTEM_RUN_DENIED",
            message:
              "SYSTEM_RUN_DENIED: auto-review denied (risk=medium): needs a person\n" +
              "Do not attempt the same outcome through a workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or ask the user to approve this exact command after explaining the risk.",
          },
        });
        expect(invoke.sendNodeEvent).toHaveBeenCalledWith(
          "exec.denied",
          expect.objectContaining({ reason: "auto-review-denied" }),
        );
      } else {
        expectError(invoke.sendInvokeResult, "exec auto-review deferred to human approval");
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves wrapper argv for approved env shell commands",
    async () => {
      for (const preferMacAppExecHost of [false, true]) {
        const tmp = fixtureDir("openclaw-approved-wrapper-");
        const invoke = await runInvoke({
          preferMacAppExecHost,
          command: ["env", "sh", "-c", "echo SAFE"],
          cwd: tmp,
          approved: true,
          security: "allowlist",
          ask: "on-miss",
          runViaResponse: preferMacAppExecHost ? macSuccess() : undefined,
        });

        if (preferMacAppExecHost) {
          const canonicalCwd = fs.realpathSync(tmp);
          expect(invoke.runCommand).not.toHaveBeenCalled();
          const macHostCall = readMacCall(invoke.requestExecHost);
          expect(macHostCall.request?.command).toEqual(["env", "sh", "-c", "echo SAFE"]);
          expect(macHostCall.request?.rawCommand).toBe('env sh -c "echo SAFE"');
          expect(macHostCall.request?.cwd).toBe(canonicalCwd);
          expect(macHostCall.request?.approvalDecision).toBe("allow-once");
          expect(macHostCall.request?.approvalSource).toBeUndefined();
          expect(macHostCall.request?.policySnapshot).toEqual(
            createExecApprovalPolicySnapshot({ file: loadExecApprovals(), agentId: undefined }),
          );
          expectOk(invoke.sendInvokeResult, "app-ok");
          continue;
        }

        expect(runArgv(invoke.runCommand)).toEqual(["env", "sh", "-c", "echo SAFE"]);
        expectOk(invoke.sendInvokeResult);
      }
    },
  );

  it("handles transparent and semantic env wrappers in allowlist mode", async () => {
    const oldPath = process.env.PATH;
    if (process.platform !== "win32") {
      process.env.PATH = "/usr/bin:/bin";
    }
    try {
      const transparent = await runLocal({
        security: "allowlist",
        command: ["env", "tr", "a", "b"],
      });
      if (process.platform === "win32") {
        expect(transparent.runCommand).not.toHaveBeenCalled();
        expectError(transparent.sendInvokeResult, "allowlist miss");
      } else {
        const expectedTrPath = fs.realpathSync(
          fs.existsSync("/usr/bin/tr") ? "/usr/bin/tr" : "/bin/tr",
        );
        expect(runArgv(transparent.runCommand)).toEqual([expectedTrPath, "a", "b"]);
        expectOk(transparent.sendInvokeResult);
      }

      const semantic = await runLocal({
        security: "allowlist",
        command: ["env", "FOO=bar", "tr", "a", "b"],
      });
      expect(semantic.runCommand).not.toHaveBeenCalled();
      expectError(semantic.sendInvokeResult, "allowlist miss");
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "rewrites nested safe-bin shell chains before execution in allowlist mode",
    async () => {
      const oldPath = process.env.PATH;
      process.env.PATH = "/usr/bin:/bin";
      try {
        const expectedTrPath = fs.realpathSync(
          fs.existsSync("/usr/bin/tr") ? "/usr/bin/tr" : "/bin/tr",
        );
        const expectedHeadPath = fs.realpathSync(
          fs.existsSync("/usr/bin/head") ? "/usr/bin/head" : "/bin/head",
        );
        const { runCommand, sendInvokeResult } = await runLocal({
          security: "allowlist",
          command: ["/bin/sh", "-lc", "sh -c 'tr a b && head -c 16'"],
          rawCommand: "sh -c 'tr a b && head -c 16'",
        });

        const payload = runArgv(runCommand)[2] ?? "";
        expect(payload).not.toContain("tr a b && head -c 16");
        expect(payload).toContain(expectedTrPath);
        expect(payload).toContain(expectedHeadPath);
        expectOk(sendInvokeResult);
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not apply POSIX safe-bin shell rewrites to PowerShell wrappers",
    async () => {
      const oldPath = process.env.PATH;
      process.env.PATH = "/usr/bin:/bin";
      try {
        const { runCommand, sendInvokeResult } = await runLocal({
          security: "allowlist",
          command: ["pwsh", "-Command", "head -c 16"],
        });

        expect(runArgv(runCommand)).toEqual(["pwsh", "-Command", "head -c 16"]);
        expectOk(sendInvokeResult);
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "pins PATH-token executable to canonical path for allowlist runs",
    async () => {
      const runCommand = vi.fn(async () => ({
        ...localResult(),
      }));
      const sendInvokeResult = vi.fn(async () => {});
      await withPathTokenCommand(
        "openclaw-allowlist-path-pin-",
        async ({ link: _link, expected }) => {
          approvalsStore.saveExecApprovals(
            policy("allowlist", "off", "deny", {
              main: {
                allowlist: [{ pattern: expected }],
              },
            }),
          );
          await runLocal({
            security: "allowlist",
            command: ["poccmd", "-n", "SAFE"],
            runCommand,
            sendInvokeResult,
          });
          expectCommandPinnedToCanonicalPath(
            runCommand,
            expected,
            ["-n", "SAFE"],
            fs.realpathSync(process.cwd()),
          );
          expectOk(sendInvokeResult);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32").each([
    { boundary: "commit", revoke: true },
    { boundary: "callback", revoke: true },
    { boundary: "callback", revoke: false },
  ] as const)(
    "checks live node policy at $boundary before real execution (revoke=$revoke)",
    async ({ boundary, revoke }) => {
      const { runCommand } = await import("./invoke-run-command.js");
      const cwd = fixtureDir("openclaw-node-policy-before-spawn-");
      fs.writeFileSync(path.join(cwd, "approved.txt"), "");
      const revokePolicy = () => {
        if (!revoke) {
          return;
        }
        const current = loadExecApprovals();
        current.defaults = { ...current.defaults, security: "deny", ask: "off" };
        current.agents = { ...current.agents, main: { security: "deny", ask: "off" } };
        approvalsStore.saveExecApprovals(current);
      };
      let stdout = "";
      const invoke = await runLocal({
        command: ["/bin/ls", "approved.txt"],
        cwd,
        commitExecAuthorization: async (params) => {
          const assertCurrent = await commitExecAuthorizationLocked(params);
          if (boundary === "commit") {
            revokePolicy();
          }
          return assertCurrent;
        },
        runCommand: async (argv, runCwd, _env, timeoutMs, signal, assertCurrent) => {
          await Promise.resolve();
          if (boundary === "callback") {
            revokePolicy();
          }
          const result = await runCommand(
            argv,
            runCwd,
            { PATH: "/usr/bin:/bin", HOME: cwd },
            timeoutMs,
            signal,
            assertCurrent,
          );
          stdout = result.stdout;
          return result;
        },
      });

      expect(stdout).toBe(revoke ? "" : "approved.txt\n");
      expect(invokeResult(invoke.sendInvokeResult).ok).toBe(!revoke);
      expect(
        invoke.sendNodeEvent.mock.calls.filter(([event]) => event === "exec.finished"),
      ).toHaveLength(revoke ? 0 : 1);
      if (revoke) {
        expect(invokeResult(invoke.sendInvokeResult).error?.code).toBe("SYSTEM_RUN_DENIED");
        expectError(invoke.sendInvokeResult, "exec approval changed before execution");
        expectExecDeniedEvent(invoke.sendNodeEvent);
      }
    },
  );

  it.runIf(process.platform !== "win32").each([
    { approval: "auto", driftAt: "unchanged" },
    { approval: "human", driftAt: "commit" },
  ] as const)(
    "checks executable identity for $approval approval when resolution is $driftAt",
    async ({ approval, driftAt }) => {
      const tmp = fixtureDir("openclaw-approval-executable-identity-");
      const prepared = prepareCwd(["/bin/sh", "-c", "ls *.ts"], tmp);
      requireApprovalPlan(prepared, "expected a bound shell command plan");
      const resolveCommand = commandResolution.resolveCommandResolutionFromArgv;
      let changed = false;
      const resolutionSpy = vi
        .spyOn(commandResolution, "resolveCommandResolutionFromArgv")
        .mockImplementation((...args) => {
          const resolution = resolveCommand(...args);
          if (!changed || args[0][0] !== "ls" || !resolution) {
            return resolution;
          }
          return {
            ...resolution,
            execution: {
              ...resolution.execution,
              resolvedPath: "/synthetic/changed/ls",
              resolvedRealPath: "/synthetic/changed/ls",
            },
          };
        });
      const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
        decision: "allow-once",
        rationale: "lists fixture files",
        risk: "low",
      }));
      const commitAuthorization: InvokeOptions["commitExecAuthorization"] = async (params) => {
        const assertCurrent = await commitExecAuthorizationLocked(params);
        changed = driftAt === "commit";
        return assertCurrent;
      };
      setRuntimeConfigSnapshot({ tools: { exec: { mode: "auto" } } });
      try {
        const invoke = await runLocal({
          command: prepared.plan.argv,
          cwd: prepared.plan.cwd ?? tmp,
          systemRunPlan: prepared.plan,
          ...(approval === "human" ? { approvalDecision: "allow-once" } : {}),
          security: "allowlist",
          ask: "on-miss",
          autoReviewer,
          commitExecAuthorization: commitAuthorization,
        });

        expect(autoReviewer).not.toHaveBeenCalled();
        if (approval === "auto") {
          expect(invoke.runCommand).not.toHaveBeenCalled();
          expectError(
            invoke.sendInvokeResult,
            "Exec auto-review skipped: dispatch chain cannot be bound",
          );
        } else {
          expect(invoke.runCommand).not.toHaveBeenCalled();
          expectError(
            invoke.sendInvokeResult,
            "SYSTEM_RUN_DENIED: approval script operand changed before execution",
            true,
          );
        }
      } finally {
        resolutionSpy.mockRestore();
      }
    },
  );

  it("revalidates approved script operands after authorization commit", async () => {
    const tmp = fixtureDir("openclaw-approval-script-post-commit-drift-");
    const fixture = createMutableScriptOperandFixture(tmp);
    fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
    if (process.platform !== "win32") {
      fs.chmodSync(fixture.scriptPath, 0o755);
    }
    const prepared = prepareCwd(fixture.command, tmp);
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    const commitAuthorization: InvokeOptions["commitExecAuthorization"] = async (params) => {
      const assertCurrent = await commitExecAuthorizationLocked(params);
      fs.writeFileSync(fixture.scriptPath, fixture.changedBody);
      return assertCurrent;
    };

    const invoke = await runLocal({
      preparedPlan: prepared.plan,
      cwd: prepared.plan.cwd ?? tmp,
      approved: true,
      commitExecAuthorization: commitAuthorization,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectError(
      invoke.sendInvokeResult,
      "SYSTEM_RUN_DENIED: approval script operand changed before execution",
      true,
    );
  });

  it("validates approved runtime script operand bindings at dispatch", async () => {
    await withFakeTsxOnPath(async () => {
      const tmp = fixtureDir("openclaw-approval-tsx-script-drift-");
      const fixture = createTsxScriptOperandFixture(tmp);
      fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
      const prepared = prepareCwd(fixture.command, tmp);
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");

      fs.writeFileSync(fixture.scriptPath, fixture.changedBody);
      const { runCommand, sendInvokeResult } = await runLocal({
        preparedPlan: prepared.plan,
        cwd: prepared.plan.cwd ?? tmp,
        approved: true,
      });

      expect(runCommand).not.toHaveBeenCalled();
      expectError(
        sendInvokeResult,
        "SYSTEM_RUN_DENIED: approval script operand changed before execution",
        true,
      );
      const missingBindingTmp = fixtureDir("openclaw-approval-tsx-missing-binding-");
      const missingBindingFixture = createTsxScriptOperandFixture(missingBindingTmp);
      fs.writeFileSync(missingBindingFixture.scriptPath, missingBindingFixture.initialBody);
      const missingBindingPrepared = prepareCwd(missingBindingFixture.command, missingBindingTmp);
      expect(missingBindingPrepared.ok).toBe(true);
      if (!missingBindingPrepared.ok) {
        throw new Error("unreachable");
      }

      const planWithoutBinding = { ...missingBindingPrepared.plan };
      delete planWithoutBinding.mutableFileOperand;
      const missingBindingRun = await runLocal({
        preparedPlan: planWithoutBinding,
        cwd: missingBindingPrepared.plan.cwd ?? missingBindingTmp,
        approved: true,
      });

      expect(missingBindingRun.runCommand).not.toHaveBeenCalled();
      expectError(
        missingBindingRun.sendInvokeResult,
        "SYSTEM_RUN_DENIED: approval missing script operand binding",
        true,
      );
    });
  });

  it("denies ./skill-bin even when autoAllowSkills trust entry exists", async () => {
    const { runCommand, sendInvokeResult, sendNodeEvent } = createInvokeSpies();

    approvalsStore.saveExecApprovals(allowlistPolicy({ autoAllowSkills: true }));
    const tempHome = sharedOpenClawHome;
    const skillBinPath = path.join(tempHome, "skill-bin");
    fs.writeFileSync(skillBinPath, "#!/bin/sh\necho should-not-run\n", { mode: 0o755 });
    fs.chmodSync(skillBinPath, 0o755);
    await runLocal({
      security: "allowlist",
      ask: "on-miss",
      command: ["./skill-bin", "--help"],
      cwd: tempHome,
      skillBinsCurrent: async () => [{ name: "skill-bin", resolvedPath: skillBinPath }],
      runCommand,
      sendInvokeResult,
      sendNodeEvent,
    });

    expect(runCommand).not.toHaveBeenCalled();
    expectApprovalRequired(sendNodeEvent, sendInvokeResult);
  });

  it("rejects unsafe environment inputs before execution", async () => {
    const shellCommand =
      process.platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", "echo ok"]
        : ["/bin/sh", "-lc", "echo ok"];
    const cases: Array<{
      label: string;
      command?: string[];
      env?: Record<string, string>;
      message: string;
      details: string[];
    }> = [
      {
        label: "blocked override",
        env: { CLASSPATH: "/tmp/evil-classpath" },
        message: "SYSTEM_RUN_DENIED: environment override rejected",
        details: ["CLASSPATH"],
      },
      {
        label: "blocked override for shell-wrapper",
        command: shellCommand,
        env: {
          CLASSPATH: "/tmp/evil-classpath",
          LANG: "C",
        },
        message: "SYSTEM_RUN_DENIED: environment override rejected",
        details: ["CLASSPATH"],
      },
      {
        label: "blocked argv assignment",
        command: ["/usr/bin/env", "SHELLOPTS=xtrace", "PS4=$(id)", "bash", "-lc", "echo ok"],
        message: "SYSTEM_RUN_DENIED: command env assignment rejected",
        details: ["SHELLOPTS", "PS4"],
      },
      {
        label: "invalid override key",
        env: { "BAD-KEY": "x" },
        message: "SYSTEM_RUN_DENIED: environment override rejected",
        details: ["BAD-KEY"],
      },
    ];

    for (const testCase of cases) {
      const { runCommand, sendInvokeResult } = await runLocal({
        command: testCase.command,
        env: testCase.env,
        executionContext: { subagent: true },
      });

      expect(runCommand, testCase.label).not.toHaveBeenCalled();
      expectError(sendInvokeResult, testCase.message);
      for (const detail of testCase.details) {
        expectError(sendInvokeResult, detail);
      }
    }
  });

  it.each([
    ["cmd.exe", "/d", "/s", "/c", "echo context"],
    ["powershell.exe", "-NoProfile", "-Command", "Write-Output context"],
    ["/bin/sh", "-c", "echo context"],
  ])("injects routing context after filtering shell overrides for %s", async (...command) => {
    const { runCommand, sendInvokeResult } = await runLocal({
      command,
      executionContext: { senderId: "sender-1", chatId: "chat-1", subagent: true },
      env: { OPENCLAW_TEST: "untrusted", OPENCLAW_SUBAGENT_EXEC: "0" },
    });
    expectOk(sendInvokeResult);
    expect(runArgv(runCommand)).toEqual(command);
    expect(firstMockCall(runCommand)[2]).toMatchObject({
      OPENCLAW_CHANNEL_CONTEXT: '{"sender":{"id":"sender-1"},"chat":{"id":"chat-1"}}',
      OPENCLAW_SUBAGENT_EXEC: "1",
    });
    expect(firstMockCall(runCommand)[2]).not.toHaveProperty("OPENCLAW_TEST");
  });

  it.each<[InvokeOptions["params"]["executionContext"], string | undefined, string | undefined]>([
    [{ chatId: "chat-1" }, '{"chat":{"id":"chat-1"}}', undefined],
    [{ subagent: true }, undefined, "1"],
    [{}, undefined, undefined],
    [undefined, undefined, undefined],
  ])(
    "applies context %j while preserving legacy inheritance",
    async (executionContext, channel, subagent) => {
      await withEnvAsync(
        {
          OPENCLAW_CHANNEL_CONTEXT: '{"chat":{"id":"old"}}',
          OPENCLAW_SUBAGENT_EXEC: "1",
          OpenClaw_Channel_Context: '{"chat":{"id":"old"}}',
          OpenClaw_Subagent_Exec: "1",
        },
        async () => {
          const inheritedMarkers = Object.fromEntries(
            Object.keys(process.env)
              .filter((key) => /^OPENCLAW_(CHANNEL_CONTEXT|SUBAGENT_EXEC)$/i.test(key))
              .map((key) => [key, process.env[key]]),
          );
          const { runCommand, sendInvokeResult } = await runLocal({ executionContext });
          expectOk(sendInvokeResult);
          const env = firstMockCall(runCommand)[2];
          if (executionContext === undefined) {
            expect(env).toMatchObject(inheritedMarkers);
          } else {
            expect(env?.OPENCLAW_CHANNEL_CONTEXT).toBe(channel);
            expect(env?.OPENCLAW_SUBAGENT_EXEC).toBe(subagent);
            expect(env).not.toHaveProperty("OpenClaw_Channel_Context");
            expect(env).not.toHaveProperty("OpenClaw_Subagent_Exec");
          }
        },
      );
    },
  );

  it("applies shell-wrapper env allowlist for shell executable commands without inline payload", async () => {
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
    expect(passedEnv).toMatchObject({ LANG: "C", LC_TIME: "C" });
    expect(passedEnv).not.toHaveProperty("OPENCLAW_TEST");
    expectOk(sendInvokeResult);
  });

  it("does not restore a revoked allowlist rule during explicit allow-always persistence", async () => {
    const tempDir = fixtureDir("openclaw-allow-always-revoked-rule-");
    const executablePath = executable(tempDir, "approved-tool");
    const matchedEntry = { pattern: fs.realpathSync(executablePath) };
    const expectedPolicySnapshot = {
      security: "allowlist" as const,
      ask: "always" as const,
      askFallback: "deny" as const,
      autoAllowSkills: false,
      allowlistRules: [matchedEntry],
    };

    approvalsStore.saveExecApprovals(
      policy("allowlist", "always", "deny", { main: { allowlist: [matchedEntry] } }),
    );
    let capturedAuthorization:
      | Parameters<typeof commitExecAuthorizationLocked>[0]["authorization"]
      | undefined;
    const commitAuthorization = vi.fn(
      async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
        capturedAuthorization = params.authorization;
        const current = loadExecApprovals();
        const main = current.agents?.main;
        approvalsStore.saveExecApprovals({
          ...current,
          agents: {
            ...current.agents,
            main: { ...main, allowlist: [] },
          },
        });
        return await commitExecAuthorizationLocked(params);
      },
    );

    const invoke = await runLocal({
      security: "allowlist",
      ask: "always",
      command: [executablePath],
      approvalDecision: "allow-always",
      approved: true,
      commitExecAuthorization: commitAuthorization,
    });

    expect(commitAuthorization).toHaveBeenCalledTimes(1);
    expect(commitAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        allowAlwaysDecision: expect.objectContaining({ kind: "patterns" }),
      }),
    );
    expect(capturedAuthorization).toEqual({
      source: "explicit-approval",
      security: "allowlist",
      ask: "always",
      allowlistSatisfied: true,
      policySnapshot: expectedPolicySnapshot,
      requireAutoAllowSkills: false,
      requireExactCommandApproval: false,
      requireDurableAllowlistApproval: false,
    });
    expect(invoke.runCommand).not.toHaveBeenCalled();
    expect(invoke.sendNodeEvent).not.toHaveBeenCalledWith("exec.finished", expect.anything());
    expect(loadExecApprovals().agents?.main?.allowlist ?? []).toStrictEqual([]);
    expectWriteDenied(invoke);
  });

  it.each([undefined, "auto-review"] as const)(
    "rejects tightened ask policy for source=%s during authorization commit",
    async (approvalSource) => {
      approvalsStore.saveExecApprovals(policy("full", "off", "deny"));
      const commitAuthorization = mutatePolicyOnCommit((current) => {
        current.defaults = { ...current.defaults, ask: "on-miss" };
      });
      const result = await runLocal({
        approvalSource,
        commitExecAuthorization: commitAuthorization,
      });

      expect(commitAuthorization).toHaveBeenCalledOnce();
      const authorization = firstMockCall(commitAuthorization)[0].authorization;
      expect(authorization.source).toBe(approvalSource ?? "current-policy");
      if (approvalSource) {
        expect(authorization.policySnapshot).toMatchObject({ ask: "off" });
      }
      expect(result.runCommand).not.toHaveBeenCalled();
      expect(result.sendNodeEvent).not.toHaveBeenCalledWith("exec.finished", expect.anything());
      expectWriteDenied(result);
    },
  );

  it("preserves exact-plan forwarded auto-review for strict inline eval", async () => {
    const plan = strictInlinePlan("openclaw-forwarded-inline-");
    setRuntimeConfigSnapshot({ tools: { exec: { strictInlineEval: true } } });
    approvalsStore.saveExecApprovals(policy("full", "on-miss", "deny"));
    const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
    const invoke = await runLocal({
      ask: "on-miss",
      preparedPlan: plan,
      approvalSource: "auto-review",
      commitExecAuthorization: commitAuthorization,
    });

    expect(commitAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({ source: "auto-review" }),
      }),
    );
    expect(invoke.runCommand).toHaveBeenCalledTimes(1);
    expectOk(invoke.sendInvokeResult);
  });

  it("does not commit allow-always state when local screen recording is unavailable", async () => {
    approvalsStore.saveExecApprovals(policy("full", "always", "deny"));
    const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
    const invoke = await runLocal({
      ask: "always",
      approvalDecision: "allow-always",
      approved: true,
      needsScreenRecording: true,
      commitExecAuthorization: commitAuthorization,
    });

    expect(commitAuthorization).not.toHaveBeenCalled();
    expect(invoke.runCommand).not.toHaveBeenCalled();
    expect(loadExecApprovals().agents?.main?.allowlist ?? []).toStrictEqual([]);
    expect(invoke.sendNodeEvent).toHaveBeenCalledWith(
      "exec.denied",
      expect.objectContaining({ reason: "permission:screenRecording" }),
    );
  });

  it("revalidates timeout fallback against the current askFallback policy", async () => {
    const prepared = prepareSession(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    approvalsStore.saveExecApprovals(policy("full", "always", "full", {}));
    const commitAuthorization = mutatePolicyOnCommit((current) => {
      current.defaults = { ...current.defaults, askFallback: "deny" };
    });
    const invoke = await runLocal({
      ask: "always",
      preparedPlan: prepared.plan,
      cwd: prepared.plan.cwd ?? undefined,
      approvalSource: "ask-fallback",
      commitExecAuthorization: commitAuthorization,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expect(invoke.sendNodeEvent).not.toHaveBeenCalledWith("exec.finished", expect.anything());
    expectWriteDenied(invoke);
  });

  it("requires a canonical plan for timeout fallback provenance", async () => {
    const invoke = await runLocal({ ask: "always", approvalSource: "ask-fallback" });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectError(invoke.sendInvokeResult, "approvalSource requires matching systemRunPlan", true);
  });

  it("requires a canonical plan for explicit approval provenance", async () => {
    const invoke = await runLocal({
      ask: "always",
      approvalDecision: "allow-once",
      approved: true,
      bindApproval: false,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectError(invoke.sendInvokeResult, "explicit approval requires matching systemRunPlan", true);
  });

  it("requires a prepared policy snapshot for forwarded delayed approval", async () => {
    const prepared = prepareSession(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    const invoke = await runLocal({
      ask: "on-miss",
      preparedPlan: prepared.plan,
      approvalSource: "auto-review",
      bindApproval: false,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectError(
      invoke.sendInvokeResult,
      "delayed approval requires a prepared policy snapshot",
      true,
    );
  });

  it("rejects explicit approval when an allowlist rule is revoked after prepare", async () => {
    approvalsStore.saveExecApprovals(
      policy("allowlist", "always", "deny", {
        main: {
          allowlist: [{ id: "rule-1", pattern: "/usr/bin/echo" }],
        },
      }),
    );
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    const policyBoundPlan = bindCurrentPolicyToPlan(prepared.plan);
    const current = loadExecApprovals();
    current.agents = { ...current.agents, main: { allowlist: [] } };
    approvalsStore.saveExecApprovals(current);
    const commitAuthorization = vi.fn(commitExecAuthorizationLocked);

    const invoke = await runLocal({
      security: "allowlist",
      ask: "always",
      preparedPlan: policyBoundPlan,
      agentId: "main",
      approvalDecision: "allow-once",
      approved: true,
      bindApproval: false,
      commitExecAuthorization: commitAuthorization,
    });

    expect(commitAuthorization).not.toHaveBeenCalled();
    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectError(invoke.sendInvokeResult, "exec approval policy changed; request approval again");
  });

  it("rejects timeout fallback provenance mixed with explicit approval", async () => {
    const invoke = await runLocal({
      ask: "always",
      approvalDecision: "allow-once",
      approvalSource: "ask-fallback",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectError(
      invoke.sendInvokeResult,
      "approvalSource cannot be combined with explicit approval",
      true,
    );
  });

  it.runIf(process.platform !== "win32")(
    "permits a durable exact-command approval under allowlist timeout fallback",
    async () => {
      const { tempDir, prepared } = durableFixture({ fallback: true });
      const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
      const invoke = await runLocal({
        ask: "always",
        preparedPlan: prepared.plan,
        cwd: prepared.plan.cwd ?? tempDir,
        approvalSource: "ask-fallback",
        commitExecAuthorization: commitAuthorization,
      });

      expect(commitAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization: expect.objectContaining({
            source: "ask-fallback",
            requireExactCommandApproval: true,
          }),
        }),
      );
      expect(invoke.runCommand).toHaveBeenCalledTimes(1);
      expectOk(invoke.sendInvokeResult);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects allowlist timeout fallback when its durable source is removed before commit",
    async () => {
      const { tempDir, prepared, commandPattern } = durableFixture({ fallback: true });
      const commitAuthorization = mutatePolicyOnCommit((current) => {
        current.agents = {
          ...current.agents,
          main: { allowlist: [{ pattern: commandPattern }] },
        };
      });
      const invoke = await runLocal({
        ask: "always",
        preparedPlan: prepared.plan,
        cwd: prepared.plan.cwd ?? tempDir,
        approvalSource: "ask-fallback",
        commitExecAuthorization: commitAuthorization,
      });

      expect(commitAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization: expect.objectContaining({
            source: "ask-fallback",
            requireExactCommandApproval: true,
          }),
        }),
      );
      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectWriteDenied(invoke);
    },
  );

  it("preserves source-only fallback across the authenticated Mac app bridge", async () => {
    const prepared = prepareSession(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    approvalsStore.saveExecApprovals(policy("full", "always", "full", {}));
    const invoke = await runMac({
      ask: "always",
      runViaResponse: macSuccess(),
      preparedPlan: prepared.plan,
      approvalSource: "ask-fallback",
    });

    const call = readMacCall(invoke.requestExecHost);
    expect(call.request?.approvalSource).toBe("ask-fallback");
    expect(call.request?.approvalDecision).toBeNull();
    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectOk(invoke.sendInvokeResult, "app-ok");
  });

  it("does not let timeout fallback satisfy strict inline review", async () => {
    const plan = strictInlinePlan("openclaw-fallback-inline-");
    setRuntimeConfigSnapshot({ tools: { exec: { strictInlineEval: true } } });
    approvalsStore.saveExecApprovals(policy("full", "always", "full", {}));
    const invoke = await runLocal({
      preparedPlan: plan,
      approvalSource: "ask-fallback",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectError(invoke.sendInvokeResult, "requires explicit approval in strictInlineEval mode");
  });

  it("rejects unknown approval provenance", async () => {
    const invoke = await runLocal({
      approved: true,
      approvalDecision: "allow-once",
      approvalSource: "explicit",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectError(invoke.sendInvokeResult, "approvalSource invalid", true);
  });

  it("persists benign awk allow-always approvals in strict inline-eval mode without reopening inline carriers", async () => {
    setRuntimeConfigSnapshot({ tools: { exec: { strictInlineEval: true } } });
    approvalsStore.saveExecApprovals(allowlistPolicy());
    const tempDir = fixtureDir("openclaw-inline-eval-awk-");
    const executablePath = executable(tempDir, "gawk");
    fs.writeFileSync(path.join(tempDir, "script.awk"), "{ print }\n");
    const benign = await runLocal({
      security: "allowlist",
      ask: "on-miss",
      command: [executablePath, "-F", ",", "-f", "script.awk"],
      cwd: tempDir,
      approvalDecision: "allow-always",
      approved: true,
      runCommand: vi.fn(async () => localResult("awk-ok")),
    });

    expect(benign.runCommand).toHaveBeenCalledTimes(1);
    expectOk(benign.sendInvokeResult, "awk-ok");
    const allowlist = loadExecApprovals().agents?.main?.allowlist ?? [];
    expect(allowlist).toHaveLength(2);
    expect(allowlist[0]?.pattern).toBe(fs.realpathSync(executablePath));
    expect(allowlist[0]?.lastUsedCommand).toBeUndefined();
    expect(allowlist[1]?.pattern).toMatch(/^=node-command:[0-9a-f]{16}$/);
    expect(allowlist[1]?.lastUsedCommand).toBeUndefined();

    const malicious = await runLocal({
      security: "allowlist",
      ask: "on-miss",
      command: [executablePath, 'BEGIN{system("id")}', "/dev/null"],
      cwd: tempDir,
    });

    expect(malicious.runCommand).not.toHaveBeenCalled();
    expectError(
      malicious.sendInvokeResult,
      "awk inline program requires explicit approval in strictInlineEval mode",
    );

    const abbreviated = await runLocal({
      security: "allowlist",
      ask: "on-miss",
      command: [executablePath, '--s=BEGIN{system("id")}', "/dev/null"],
      cwd: tempDir,
    });

    expect(abbreviated.runCommand).not.toHaveBeenCalled();
    expectError(
      abbreviated.sendInvokeResult,
      "gawk --source requires explicit approval in strictInlineEval mode",
    );
  });

  it("does not persist allow-always approvals for strict inline-eval make carriers", async () => {
    setRuntimeConfigSnapshot({ tools: { exec: { strictInlineEval: true } } });
    approvalsStore.saveExecApprovals(allowlistPolicy());
    const tempDir = fixtureDir("openclaw-inline-eval-make-");
    const executablePath = executable(tempDir, "make");
    const makefilePath = path.join(tempDir, "Makefile");
    fs.writeFileSync(makefilePath, "all:\n\t@echo inline-eval-ok\n");
    const prepared = prepareCwd([executablePath, "-f", makefilePath], tempDir);
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");

    const { runCommand, sendInvokeResult } = await runLocal({
      security: "allowlist",
      ask: "on-miss",
      preparedPlan: prepared.plan,
      cwd: prepared.plan.cwd ?? tempDir,
      approvalDecision: "allow-always",
      approved: true,
      runCommand: vi.fn(async () => localResult("inline-eval-ok")),
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expectOk(sendInvokeResult, "inline-eval-ok");
    expect(loadExecApprovals().agents?.main?.allowlist ?? []).toStrictEqual([]);
  });

  it("keeps cmd.exe transport wrappers approval-gated on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      for (const testCase of [
        {
          name: "env-assignment cmd.exe",
          commandPrefix: ["env", "FOO=bar", "cmd.exe", "/d", "/s", "/c"],
        },
      ]) {
        const tempDir = fixtureDir("openclaw-cmd-wrapper-allow-");
        const scriptPath = path.join(tempDir, "check_mail.cmd");
        fs.writeFileSync(scriptPath, "@echo off\r\necho ok\r\n");
        const command = [...testCase.commandPrefix, `${scriptPath} --limit 5`];

        approvalsStore.saveExecApprovals(
          allowlistPolicy({
            agents: {
              main: {
                allowlist: [{ pattern: scriptPath }],
              },
            },
          }),
        );
        const invoke = await runLocal({
          security: "allowlist",
          ask: "on-miss",
          command,
          cwd: tempDir,
        });

        expect(invoke.runCommand, testCase.name).not.toHaveBeenCalled();
        expectApprovalRequired(invoke.sendNodeEvent, invoke.sendInvokeResult);
      }
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("fails closed when cmd.exe wrapper trust is downgraded before execution", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const tempDir = fixtureDir("openclaw-cmd-wrapper-downgraded-");
      const commandName = "check_mail.cmd";
      const command = ["env", "FOO=bar", "cmd.exe", "/d", "/s", "/c", `${commandName} --limit 5`];
      const ordinaryPattern = "*";
      const prepared = buildSystemRunApprovalPlan({ command, cwd: tempDir });
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const commandPattern = createExactCommandPattern(prepared.plan.commandText);

      approvalsStore.saveExecApprovals(
        allowlistPolicy({
          agents: {
            main: {
              allowlist: [
                { pattern: ordinaryPattern },
                { pattern: commandPattern, source: "allow-always" },
              ],
            },
          },
        }),
      );
      const commitAuthorization = mutatePolicyOnCommit((current) => {
        current.agents = {
          ...current.agents,
          main: {
            allowlist: [{ pattern: ordinaryPattern }, { pattern: commandPattern }],
          },
        };
      });
      const invoke = await runLocal({
        security: "allowlist",
        ask: "on-miss",
        preparedPlan: prepared.plan,
        cwd: prepared.plan.cwd ?? tempDir,
        commitExecAuthorization: commitAuthorization,
      });

      expect(commitAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization: expect.objectContaining({
            source: "current-policy",
            requireExactCommandApproval: true,
          }),
        }),
      );
      expect(invoke.runCommand).not.toHaveBeenCalled();
      expect(invoke.sendNodeEvent).not.toHaveBeenCalledWith("exec.finished", expect.anything());
      expectWriteDenied(invoke);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects durable trust when its approved directory is replaced before execution",
    async () => {
      const { tempDir, prepared } = durableFixture();
      const movedDir = `${tempDir}-moved`;
      const commitAuthorization: InvokeOptions["commitExecAuthorization"] = async (params) => {
        const assertCurrent = await commitExecAuthorizationLocked(params);
        fs.renameSync(tempDir, movedDir);
        fs.mkdirSync(tempDir);
        return assertCurrent;
      };
      const rerun = await runLocal({
        security: "allowlist",
        ask: "on-miss",
        preparedPlan: prepared.plan,
        cwd: prepared.plan.cwd ?? tempDir,
        commitExecAuthorization: commitAuthorization,
      });

      expect(rerun.runCommand).not.toHaveBeenCalled();
      expectError(
        rerun.sendInvokeResult,
        "SYSTEM_RUN_DENIED: approval cwd changed before execution",
        true,
      );
    },
  );

  it("does not bind safe builtin policy to a redundant exact-command grant", async () => {
    if (process.platform === "win32") {
      return;
    }

    const { tempDir, prepared } = durableFixture({ payload: "cd ." });
    const commitAuthorization = mutatePolicyOnCommit((current) => {
      current.agents = { ...current.agents, main: { allowlist: [] } };
    });
    const rerun = await runLocal({
      security: "allowlist",
      ask: "on-miss",
      preparedPlan: prepared.plan,
      cwd: prepared.plan.cwd ?? tempDir,
      commitExecAuthorization: commitAuthorization,
      runCommand: vi.fn(async () => localResult("safe-builtin-ok")),
    });

    expect(commitAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          requireExactCommandApproval: false,
          requireDurableAllowlistApproval: false,
        }),
      }),
    );
    expect(rerun.runCommand).toHaveBeenCalledTimes(1);
    expectOk(rerun.sendInvokeResult, "safe-builtin-ok");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
