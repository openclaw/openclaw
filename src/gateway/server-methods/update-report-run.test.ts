import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RunGithubCli } from "../../infra/github-issue.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import { parseUpdateDoctorLintReport } from "../../infra/update-doctor-lint.js";
import type { UpdateFailureFact } from "../../infra/update-failure-facts.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import { runStep } from "../../infra/update-runner-command.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { GatewayConnectionWork } from "../server-connection-work.js";
import { runGatewayCloseSteps } from "../server-shutdown.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  runGh: vi.fn<RunGithubCli>(),
  sentinel: vi.fn<() => Promise<RestartSentinelPayload | null>>(),
}));

vi.mock("../../plugins/bundled-plugin-metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/bundled-plugin-metadata.js")>();
  return {
    ...actual,
    listBundledPluginMetadata: (...args: Parameters<typeof actual.listBundledPluginMetadata>) => {
      const entries = actual.listBundledPluginMetadata(...args);
      const shipped = entries.find((entry) => entry.manifest.id === "discord");
      if (!shipped) {
        throw new Error("Missing shipped Discord metadata fixture");
      }
      return [
        ...entries,
        {
          ...shipped,
          dirName: "private-customer-plugin",
          idHint: "private-customer-plugin",
          manifest: { ...shipped.manifest, id: "private-customer-plugin" },
        },
      ];
    },
  };
});

vi.mock("../../infra/github-issue.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/github-issue.js")>(
    "../../infra/github-issue.js",
  );
  return {
    ...actual,
    submitGithubIssue: (
      issue: Parameters<typeof actual.submitGithubIssue>[0],
      _runGh: unknown,
      hooks: Parameters<typeof actual.submitGithubIssue>[2],
    ) => actual.submitGithubIssue(issue, mocks.runGh, hooks),
    reconcileGithubIssue: (
      issue: Parameters<typeof actual.reconcileGithubIssue>[0],
      _runGh: unknown,
      hooks: Parameters<typeof actual.reconcileGithubIssue>[2],
    ) => actual.reconcileGithubIssue(issue, mocks.runGh, hooks),
  };
});
vi.mock("../server-update-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-update-sentinel.js")>()),
  refreshLatestUpdateRestartSentinel: mocks.sentinel,
}));

const { updateReportHandler } = await import("./update-report.js");
const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
let home: TempHomeEnv;

type ClientAuthority = Pick<
  NonNullable<GatewayRequestHandlerOptions["client"]>,
  "internal" | "authenticatedUserProfile" | "connectionSignal"
>;

function namedAdministrator(profileId = "11111111-2222-4333-8444-555555555555"): ClientAuthority {
  return {
    authenticatedUserProfile: {
      profileId,
      displayName: "Example administrator",
      hasAvatar: false,
      updatedAt: 0,
    },
  };
}

function expectPartialReply(respond: unknown, payload: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(payload));
}

function expectError(respond: unknown, error: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

function expectText(text: string | undefined, contains: string[] = [], excludes: string[] = []) {
  for (const value of contains) {
    expect(text).toContain(value);
  }
  for (const value of excludes) {
    expect(text).not.toContain(value);
  }
}

async function expectNoReport({ github = true } = {}) {
  expect(await reportFiles()).toEqual([]);
  if (github) {
    expect(mocks.runGh).not.toHaveBeenCalled();
  }
}

function ghResult(stdout = "", status = 0) {
  return { started: true, status, stdout: Buffer.from(stdout) };
}
function ghPhases() {
  return mocks.runGh.mock.calls.map(([args]) => args[0]);
}
function submissionBody() {
  return mocks.runGh.mock.calls.find(([args]) => args[0] === "api")?.[1]?.input?.toString();
}
function recordFactFailure(
  failureFacts: UpdateFailureFact[] | undefined,
  step = "doctor",
  reason = "doctor-failed",
  extraSteps: { step: string; failureFacts?: UpdateFailureFact[] }[] = [],
  detail?: string,
) {
  createUpdateRun({ runId, trigger: "control-ui" });
  recordUpdateRunPhase(runId, "validating", {
    step: { step, status: "failed", failureFacts, detail },
  });
  for (const entry of extraSteps) {
    recordUpdateRunStep(runId, { ...entry, status: "failed" });
  }
  finishUpdateRun(runId, { status: "failed", reason });
}
function submit(previewDigest: string, authority?: ClientAuthority) {
  return invoke({ action: "submit", attemptId: runId, previewDigest }, undefined, authority);
}

function submitParams(previewDigest: string) {
  return { action: "submit", attemptId: runId, previewDigest };
}
function publicFact(
  check: string,
  code: string,
  message: string,
  publicMessage = message,
  fields: Pick<UpdateFailureFact, "affectedKey" | "pluginId"> = {},
) {
  return { check, code, message, publicMessage, ...fields };
}

async function invoke(
  params: Record<string, unknown>,
  hasCurrentClientAuthority: (() => boolean) | null = () => true,
  authority: ClientAuthority = { internal: { operatorRoleActor: { kind: "system" } } },
  trackExecution?: GatewayRequestHandlerOptions["context"]["trackExecution"],
) {
  const respond = vi.fn<RespondFn>();
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "report-run-test", method: "update.report", params },
    params,
    respond,
    ...(hasCurrentClientAuthority ? { hasCurrentClientAuthority } : {}),
    client: {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
        role: "operator",
        scopes: ["operator.admin"],
      },
      ...authority,
    },
    isWebchatConnect: () => false,
    context: createDirectChatContext({
      ...(trackExecution ? { trackExecution } : {}),
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    }),
  };
  await updateReportHandler(options);
  return respond;
}

function recordFailure(status: "failed" | "rolled-back" = "failed") {
  createUpdateRun({
    runId,
    trigger: "control-ui",
    before: { version: "2026.9.1" },
    target: { kind: "git", sha: "f".repeat(40) },
    origin: { sessionKey: "private-session", doctorHint: "private-command --token private-secret" },
  });
  recordUpdateRunPhase(runId, "validating", {
    step: { step: "build", status: "failed", detail: "private-raw-log" },
  });
  finishUpdateRun(runId, { status, reason: "build-failed", after: { version: "2026.9.2" } });
}

function matchingSentinel(): RestartSentinelPayload {
  return {
    kind: "update",
    status: "error",
    ts: Date.now(),
    stats: {
      runId,
      handoffId: "different-handoff",
      mode: "git",
      reason: "build-failed",
      recovery: { serviceRestartSafe: true, version: "2026.9.1" },
      steps: [
        {
          name: "build",
          command: "private-command",
          log: { exitCode: 2, stderrTail: "private-raw-log" },
        },
      ],
    },
  };
}

async function preview(authority?: ClientAuthority) {
  const respond = await invoke({ action: "preview", attemptId: runId }, undefined, authority);
  expectPartialReply(respond, { status: "ready", attemptId: runId });
  const result = respond.mock.calls[0]?.[1];
  if (
    !isRecord(result) ||
    typeof result.previewDigest !== "string" ||
    typeof result.body !== "string"
  ) {
    throw new Error("Missing report preview");
  }
  return { body: result.body, previewDigest: result.previewDigest };
}

async function reportFiles() {
  return await fs
    .readdir(path.join(home.home, ".openclaw", "update-reports"))
    .catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
}

beforeEach(async () => {
  home = await createTempHomeEnv("openclaw-update-report-run-");
  mocks.sentinel.mockReset().mockResolvedValue(null);
  mocks.runGh
    .mockReset()
    .mockImplementation(async (args) =>
      ghResult(args[0] === "auth" ? "" : args[0] === "issue" ? "[]" : issueUrl),
    );
});
afterEach(async () => {
  await home.restore();
  closeOpenClawStateDatabaseForTest();
});
afterAll(closeStateDatabaseForTest);

describe("Report action from the authoritative update ledger", () => {
  it("keeps ledger diagnostics when a matching requested sentinel has no facts", async () => {
    createUpdateRun({ runId, trigger: "control-ui", target: { kind: "git", tag: "main" } });
    recordUpdateRunStep(runId, {
      step: "requested",
      status: "failed",
      exitCode: 23,
      detail: "EACCES: permission denied at /private/customer token=synthetic-private-token",
      failureFacts: [{ check: "readyz", code: "readyz-unhealthy" }],
    });
    finishUpdateRun(runId, { status: "failed", reason: "update-failed" });
    mocks.sentinel.mockResolvedValue({
      ...matchingSentinel(),
      stats: {
        runId,
        mode: "unknown",
        reason: "update-failed",
        steps: [{ name: "requested", command: "", log: { exitCode: null } }],
      },
    });
    const { body } = await preview();
    expect(body).toContain("Update mode: git");
    expect(body).toContain("Update target: main");
    expect(body).toContain("Failed phase requested: exit 23 (EACCES; Permission denied)");
    expect(body).toContain("Failing check readyz (readyz-unhealthy)");
    expect(body).not.toMatch(/exit unknown|\/private\/customer|synthetic-private-token/u);
  });

  it.each([
    {
      text: "Command failed with exit code 1: custom-tool --customer private-customer-text",
      code: "EACCES",
      publicCode: "EACCES",
    },
    { text: "custom-tool private-customer-text", code: "EACCES", publicCode: "EACCES" },
    { text: "Permission denied for private-customer-text", code: "EACCES", publicCode: "EACCES" },
    {
      text: "npm error code PRIVATE_CUSTOMER_ID",
      code: "PRIVATE_CUSTOMER_ID",
      publicCode: "[redacted-code]",
    },
  ])(
    "excludes poisoned command diagnostics through ledger and public preview: $text",
    async ({ text, code, publicCode }) => {
      const onStepComplete = vi.fn();
      const step = await runStep({
        name: "package-stage",
        argv: ["npm", "install"],
        cwd: home.home,
        timeoutMs: 1000,
        stepIndex: 0,
        totalSteps: 1,
        progress: { onStepComplete },
        runCommand: async () => ({
          code: 1,
          stdout: "",
          stderr: `${text}; host=private-host.example token=synthetic-private-token path="/Users/Example Person/private/config.json"\nnpm error code EACCES\n${"cleanup output\n".repeat(1000)}`,
        }),
      });
      expect(step.stderrTail).not.toContain("EACCES");
      expect(step.failureFacts?.[0]?.message).toContain(text.split(" ")[0]);
      expect(onStepComplete).toHaveBeenCalledWith(
        expect.objectContaining({ failureFacts: step.failureFacts }),
      );
      createUpdateRun({ runId, trigger: "control-ui" });
      recordUpdateRunPhase(runId, "validating", { step: updateRunStepsFromResultStep(step)[0] });
      finishUpdateRun(runId, { status: "failed", reason: "global-install-failed" });
      const recorded = getUpdateRun(runId);
      expect(recorded?.steps.at(-1)?.failureFacts?.[0]?.message?.length).toBeLessThanOrEqual(200);
      const { body, previewDigest } = await preview();
      expectText(
        body,
        [`Failing check package-stage (${publicCode})`],
        [
          "PRIVATE_CUSTOMER_ID",
          "private-customer-text",
          "private-host.example",
          "synthetic-private-token",
          "Example Person",
          "config.json",
        ],
      );
      expect(recorded?.steps.at(-1)?.failureFacts?.[0]?.code).toBe(code);
      await submit(previewDigest);
      expectText(
        submissionBody(),
        ["package-stage"],
        ["private-customer-text", "PRIVATE_CUSTOMER_ID"],
      );
    },
  );

  it.each([
    ["check", "core/doctor/private-customer-check", "[redacted-check]"],
    ["code", "private-customer-code", "[redacted-code]"],
    ["pluginId", "private-customer-plugin", "[redacted-plugin]"],
    [
      "path",
      "hooks.internal.entries.private-customer-key.enabled",
      "hooks.internal.entries.<id>.enabled",
    ],
    [
      "path",
      "gateway.auth.identityScopes.private-customer-key",
      "gateway.auth.identityScopes.<id>",
    ],
    ["path", "tools.byProvider.private-customer-key.profile", "tools.byProvider.<id>.profile"],
  ] as const)(
    "keeps private %s %s local when publishing a report",
    async (field, value, marker) => {
      if (field === "path") {
        const doctor = parseUpdateDoctorLintReport(
          JSON.stringify({
            ok: false,
            checksRun: 1,
            findings: [
              {
                checkId: "core/doctor/final-config-validation",
                severity: "error",
                message: "Invalid input: expected boolean, received string",
                path: value,
              },
            ],
          }),
        );
        recordFactFailure(doctor?.failureFacts);
      } else {
        recordFactFailure([
          { check: "doctor", code: "doctor-failed", pluginId: "discord", [field]: value },
        ]);
      }
      expect(getUpdateRun(runId)?.steps.flatMap((step) => step.failureFacts ?? [])).toContainEqual(
        expect.objectContaining({ [field === "path" ? "affectedKey" : field]: value }),
      );
      const { body, previewDigest } = await preview();
      const excluded = field === "path" ? "private-customer-key" : value;
      expectText(
        body,
        field === "path"
          ? ["core/doctor/final-config-validation (doctor-failed)", `key ${marker}`]
          : [marker],
        [excluded],
      );
      await submit(previewDigest);
      expectText(submissionBody(), [], [excluded]);
    },
  );

  it.each([
    publicFact(
      "core/doctor/runtime-tool-schemas",
      "doctor-failed",
      "connect ECONNREFUSED",
      "ECONNREFUSED",
      { affectedKey: "mcp.servers" },
    ),
    publicFact(
      "readyz",
      "readyz-unhealthy",
      "Gateway readiness endpoint returned HTTP 503; expected HTTP 200.",
    ),
    publicFact("package-install", "EACCES", "npm error code EACCES", "EACCES"),
    publicFact("package-swap", "Error", "ENOENT: rollback launcher backup missing", "ENOENT"),
    publicFact(
      "managed-service",
      "systemd-user-bus-unavailable",
      "Connection refused to systemd user bus",
      "Connection refused",
    ),
    publicFact(
      "plugin-update",
      "incompatible_plugin_api",
      "Plugin requires a newer host API.",
      "[redacted-diagnostic]",
      { pluginId: "discord" },
    ),
  ])("retains $check through the ledger and public preview", async ({ publicMessage, ...fact }) => {
    recordFactFailure(
      [fact],
      "failing check",
      "update-failed",
      [
        ...["package rollback", "repairing", "repair attempt 1", "repair attempt 2"].map(
          (step) => ({ step }),
        ),
        ...["global install rollback", "global install backup retention"].map((step) => ({
          step,
          failureFacts: [
            {
              check: "package-swap",
              code: "swap-failed",
              message: "Rollback verification timed out",
            },
          ],
        })),
      ],
      "private-raw-log",
    );
    const recorded = getUpdateRun(runId)!;
    expect(recorded.steps.find((step) => step.step === "failing check")?.failureFacts).toEqual([
      fact,
    ]);
    const { body } = await preview();
    expect(body.match(/^- Failed phase /gmu)).toHaveLength(3);
    expect(body).toContain("Failing check package-swap (swap-failed)");
    expect(body).toContain(`Failing check ${fact.check} (${fact.code})`);
    if (fact.affectedKey) {
      expect(body).toContain(fact.affectedKey);
    }
    if (fact.pluginId) {
      expect(body).toContain(fact.pluginId);
    }
    expectText(body, [`: ${publicMessage}\n`], ["private-raw-log"]);
  });
  it.each([
    { reason: "not-git-install", reportable: true },
    { reason: "already-current", reportable: false },
    { reason: "managed-service-handoff-unavailable", reportable: false },
    { reason: "immutable-native-updater-required", reportable: false },
    { reason: "restart-disabled", reportable: false },
    { reason: "downgrade-confirmation-required", reportable: false },
    { reason: "dry-run", reportable: false },
    { reason: "cancelled", reportable: false },
  ])(
    "keeps skipped $reason reporting aligned with the actual outcome",
    async ({ reason, reportable }) => {
      createUpdateRun({ runId, trigger: "control-ui" });
      finishUpdateRun(runId, { status: "skipped", reason });
      const respond = await invoke({ action: "preview", attemptId: runId });
      if (reportable) {
        expectPartialReply(respond, {
          status: "ready",
          attemptId: runId,
          body: expect.stringContaining(reason),
        });
      } else {
        expectError(respond, { code: "INVALID_REQUEST" });
      }
      await expectNoReport();
    },
  );

  it.each(["rolled-back"] as const)(
    "previews %s without treating its status as verified rollback",
    async (status) => {
      recordFailure(status);
      const result = await preview();
      expectText(
        result.body,
        ["f".repeat(40), "build", "2026.9.1", "2026.9.2", "Result: rolled-back"],
        ["private-", "Recovery outcome:"],
      );
      expect(Buffer.byteLength(result.body)).toBeLessThan(16_000);
      await expectNoReport();
    },
  );

  it.each(["running", "succeeded"] as const)(
    "refuses a retained failed sentinel while the canonical run is %s",
    async (status) => {
      createUpdateRun({ runId, trigger: "control-ui" });
      if (status === "succeeded") {
        finishUpdateRun(runId, { status });
      }
      mocks.sentinel.mockResolvedValue(matchingSentinel());
      const respond = await invoke({ action: "preview", attemptId: runId });
      expectError(respond, { code: "INVALID_REQUEST" });
      await expectNoReport();
    },
  );

  it("finishes an admitted host submission when its connection retires during transport", async () => {
    recordFailure();
    const connection = new AbortController();
    const authority: ClientAuthority = {
      ...namedAdministrator(GATEWAY_OWNER_PROFILE_ID),
      connectionSignal: connection.signal,
    };
    const { previewDigest } = await preview(authority);
    const paused = createDeferred();
    const resume = createDeferred();
    mocks.runGh.mockImplementationOnce(async (args) => {
      expect(args[0]).toBe("auth");
      paused.resolve();
      await resume.promise;
      return ghResult();
    });
    const params = submitParams(previewDigest);
    const submitting = invoke(params, () => true, authority);
    await paused.promise;
    // The host retires the socket without changing its admitted auth generation.
    connection.abort();
    resume.resolve();
    const respond = await submitting;
    expect(ghPhases()).toEqual(["auth", "issue", "api"]);
    expect(respond).not.toHaveBeenCalled();
    expect(await reportFiles()).toEqual([]);
  });

  it("does not prepare a preview for an already-retired connection", async () => {
    recordFailure();
    const connection = new AbortController();
    connection.abort();
    const respond = await invoke({ action: "preview", attemptId: runId }, () => true, {
      internal: { operatorRoleActor: { kind: "system" } },
      connectionSignal: connection.signal,
    });
    expect(respond).not.toHaveBeenCalled();
    expect(mocks.sentinel).not.toHaveBeenCalled();
    await expectNoReport();
  });

  it("settles accepted report transport before Gateway close", async () => {
    recordFailure();
    const connection = new AbortController();
    const work = new GatewayConnectionWork();
    const created = createDeferred();
    const releaseResponse = createDeferred();
    const closeStarted = createDeferred();
    const authority: ClientAuthority = {
      internal: { operatorRoleActor: { kind: "system" } },
      connectionSignal: connection.signal,
    };
    const { previewDigest } = await preview(authority);
    mocks.runGh.mockImplementation(async (args) => {
      if (args[0] === "api") {
        created.resolve();
        await releaseResponse.promise;
        return ghResult(issueUrl);
      }
      return ghResult(args[0] === "issue" ? "[]" : "");
    });
    const params = submitParams(previewDigest);
    const submitting = invoke(
      params,
      () => true,
      authority,
      (run) => work.track(run),
    );
    await created.promise;
    connection.abort();
    work.beginClose();
    const close = vi.fn(async () => {
      expect(await reportFiles()).toEqual([]);
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    });
    const closeError = vi.fn();
    const noWork = async () => {};
    const closing = runGatewayCloseSteps({
      owner: {
        connectionWork: work,
        stopConnectionDependentSidecars: async () => {
          closeStarted.resolve();
        },
        stopRegisteredGatewayLifetimeSidecars: noWork,
        stopRegisteredPostReadySidecars: noWork,
        runClosePrelude: noWork,
        sealAndJoinRegisteredSidecarStops: noWork,
      },
      close,
      onError: closeError,
    });
    void closing.catch(() => {});
    try {
      await closeStarted.promise;
      expect(work.hasPendingWork).toBe(true);
      expect(close).not.toHaveBeenCalled();
    } finally {
      releaseResponse.resolve();
      await submitting;
      await closing;
    }
    expect(close).toHaveBeenCalledOnce();
    expect(closeError).not.toHaveBeenCalled();
    expect(ghPhases()).toEqual(["auth", "issue", "api"]);
    expect(await reportFiles()).toEqual([]);
  });

  it.each(["duplicate-finalization", "changed-sentinel"] as const)(
    "handles %s during auth preflight using authoritative final facts",
    async (change) => {
      recordFailure();
      mocks.sentinel.mockResolvedValue(matchingSentinel());
      const { previewDigest } = await preview();
      mocks.runGh.mockImplementation(async (args) => {
        if (args[0] === "api") {
          return ghResult(issueUrl);
        }
        if (args[0] === "issue") {
          return ghResult("[]");
        }
        expect(args[0]).toBe("auth");
        if (change === "duplicate-finalization") {
          const retained = finishUpdateRun(runId, {
            status: "failed",
            reason: "build-failed",
            after: { version: "2026.9.3" },
          });
          expect(retained.after.version).toBe("2026.9.2");
        } else {
          const sentinel = matchingSentinel();
          mocks.sentinel.mockResolvedValue({
            ...sentinel,
            stats: {
              ...sentinel.stats,
              recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
            },
          });
        }
        return ghResult();
      });
      const respond = await submit(previewDigest);
      expectPartialReply(respond, { status: "created", url: issueUrl });
      expect(ghPhases()).toEqual(["auth", "issue", "api"]);
      expect(await reportFiles()).toEqual([]);
    },
  );

  it("requires live authenticated authority before preparing a report", async () => {
    recordFailure();
    const respond = await invoke({ action: "preview", attemptId: runId }, null);
    expectError(respond, { code: "INVALID_REQUEST" });
    await expectNoReport();
  });

  it("does not authenticate the host when a named administrator reports in a browser", async () => {
    recordFailure();
    const authority = namedAdministrator();
    const { previewDigest } = await preview(authority);
    const respond = await submit(previewDigest, authority);
    expectPartialReply(respond, {
      status: "fallback",
      fallbackUrl: expect.stringContaining("github.com/openclaw/openclaw/issues/new"),
    });
    await expectNoReport();
  });

  it("rejects consent for a replaced attempt instead of reporting another run", async () => {
    recordFailure();
    const { previewDigest } = await preview();
    createUpdateRun({ trigger: "control-ui" });
    const respond = await submit(previewDigest);
    expectError(respond, { code: "INVALID_REQUEST" });
    await expectNoReport();
  });
});
