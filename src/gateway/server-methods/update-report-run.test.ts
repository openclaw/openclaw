import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runInteractiveUpdateFailureAction } from "../../cli/update-cli/update-command-report.js";
import type { RunGithubCli } from "../../infra/github-issue.js";
import {
  readUpdateFailureReportReceipt,
  type RestartSentinelPayload,
} from "../../infra/restart-sentinel.js";
import { parseUpdateDoctorLintReport } from "../../infra/update-doctor-lint.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import { runStep } from "../../infra/update-runner-command.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  runGh: vi.fn<RunGithubCli>(),
  sentinel: vi.fn<() => Promise<RestartSentinelPayload | null>>(),
  select: vi.fn<() => Promise<string | symbol>>(),
  confirm: vi.fn<() => Promise<boolean | symbol>>(),
}));

vi.mock("../../commands/configure.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/configure.shared.js")>()),
  select: mocks.select,
  confirm: mocks.confirm,
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
vi.mock("../server-restart-sentinel.js", () => ({
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

async function invoke(
  params: Record<string, unknown>,
  hasCurrentClientAuthority = () => true,
  authority: ClientAuthority = { internal: { operatorRoleActor: { kind: "system" } } },
) {
  const respond = vi.fn<RespondFn>();
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "report-run-test", method: "update.report", params },
    params,
    respond,
    hasCurrentClientAuthority,
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
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ status: "ready", attemptId: runId }),
  );
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
  mocks.select.mockReset().mockResolvedValue("report");
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.sentinel.mockReset().mockResolvedValue(null);
  mocks.runGh.mockReset().mockImplementation(async (args) => ({
    started: true,
    status: 0,
    stdout: Buffer.from(args[0] === "auth" ? "" : issueUrl),
  }));
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await home.restore();
});

describe("Report action from the authoritative update ledger", () => {
  it.each(["compact", "direct-success", "other-scope"] as const)(
    "enriches only the same scoped attempt in lifecycle order: %s",
    async (mode) => {
      createUpdateRun({ runId, trigger: "cli" });
      recordUpdateRunPhase(runId, "activating");
      recordUpdateRunPhase(runId, "verifying");
      recordUpdateRunStep(runId, { step: "activating", status: "failed" });
      recordUpdateRunStep(runId, {
        step: "verifying",
        status: "failed",
        failureFacts: [
          {
            check: "readyz",
            code: "readyz-unhealthy",
            message: "Gateway readiness endpoint returned HTTP 503; expected HTTP 200.",
          },
        ],
      });
      finishUpdateRun(runId, { status: "failed", reason: "verification-failed" });
      mocks.confirm.mockResolvedValue(false);
      const runtime = { log: vi.fn(), error: vi.fn() };
      await runInteractiveUpdateFailureAction({
        attemptId: runId,
        env:
          mode === "other-scope"
            ? { ...process.env, OPENCLAW_STATE_DIR: path.join(home.home, "other-scope") }
            : process.env,
        result: {
          status: "error",
          mode: "npm",
          reason: "verification-failed",
          durationMs: 1,
          steps: [
            {
              name: "verifying",
              command: "",
              cwd: "",
              durationMs: 1,
              exitCode: mode === "direct-success" ? 0 : 7,
            },
          ],
        },
        runtime,
      });
      const body =
        runtime.log.mock.calls
          .map(([text]) => String(text))
          .find((text) => text.startsWith("# OpenClaw update failure report")) ?? "";
      expect(runtime.error).not.toHaveBeenCalled();
      if (mode === "other-scope") {
        expect(body).not.toContain("Failed phase activating");
        expect(body).not.toContain("Failing check readyz");
      } else {
        expect(body).toContain("Failed phase activating: exit unknown");
        if (mode === "compact") {
          expect(body.indexOf("Failed phase activating: exit unknown")).toBeLessThan(
            body.indexOf("Failed phase verifying: exit 7"),
          );
          expect(body.match(/Failed phase verifying:/gu)).toHaveLength(1);
          expect(body).toContain("Failing check readyz (readyz-unhealthy)");
        } else {
          expect(body).not.toContain("Failed phase verifying:");
          expect(body).not.toContain("Failing check readyz");
        }
      }
    },
  );

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
        name: "global install stage",
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
      expect(body).not.toContain("PRIVATE_CUSTOMER_ID");
      expect(renderUpdateRunReport(recorded!).lines.join("\n")).toContain(
        `Failing check package-install (${code})`,
      );
      expect(body).toContain(`Failing check package-install (${publicCode})`);
      for (const privateText of [
        "private-customer-text",
        "private-host.example",
        "synthetic-private-token",
        "Example Person",
        "config.json",
      ]) {
        expect(body).not.toContain(privateText);
      }
      await invoke({ action: "submit", attemptId: runId, previewDigest });
      const submission = mocks.runGh.mock.calls.find(([args]) => args[0] === "api");
      expect(submission?.[1]?.input?.toString()).toContain("package-install");
      expect(submission?.[1]?.input?.toString()).not.toContain("private-customer-text");
      expect(submission?.[1]?.input?.toString()).not.toContain("PRIVATE_CUSTOMER_ID");
    },
  );

  it.each([
    { field: "check", value: "core/doctor/private-customer-check", marker: "[redacted-check]" },
    { field: "code", value: "private-customer-code", marker: "[redacted-code]" },
    { field: "pluginId", value: "private-customer-plugin", marker: "[redacted-plugin]" },
  ] as const)(
    "keeps an unrecognized $field local, including unshipped extensions, when publishing a report",
    async ({ field, value, marker }) => {
      const fact = { check: "doctor", code: "doctor-failed", pluginId: "discord", [field]: value };
      createUpdateRun({ runId, trigger: "control-ui" });
      recordUpdateRunPhase(runId, "validating", {
        step: { step: "doctor", status: "failed", failureFacts: [fact] },
      });
      finishUpdateRun(runId, { status: "failed", reason: "doctor-failed" });
      expect(renderUpdateRunReport(getUpdateRun(runId)!).lines.join("\n")).toContain(value);
      const { body, previewDigest } = await preview();
      expect(body).not.toContain(value);
      expect(body).toContain(marker);
      await invoke({ action: "submit", attemptId: runId, previewDigest });
      const submission = mocks.runGh.mock.calls.find(([args]) => args[0] === "api");
      expect(submission?.[1]?.input?.toString()).not.toContain(value);
    },
  );

  it.each([
    ["hooks.internal.entries.private-customer-key.enabled", "hooks.internal.entries.*"],
    ["gateway.auth.identityScopes.private-customer-key", "gateway.*"],
    ["tools.byProvider.private-customer-key.profile", "tools.*"],
  ])(
    "removes operator names from Doctor config path %s in public reports",
    async (configKey, publicKey) => {
      const doctor = parseUpdateDoctorLintReport(
        JSON.stringify({
          ok: false,
          checksRun: 1,
          findings: [
            {
              checkId: "core/doctor/final-config-validation",
              severity: "error",
              message: "Invalid input: expected boolean, received string",
              path: configKey,
            },
          ],
        }),
      );
      createUpdateRun({ runId, trigger: "control-ui" });
      recordUpdateRunPhase(runId, "validating", {
        step: { step: "doctor", status: "failed", failureFacts: doctor?.failureFacts },
      });
      finishUpdateRun(runId, { status: "failed", reason: "doctor-failed" });
      expect(renderUpdateRunReport(getUpdateRun(runId)!).lines.join("\n")).toContain(configKey);
      const { body, previewDigest } = await preview();
      expect(body).toContain("core/doctor/final-config-validation (doctor-failed)");
      expect(body).not.toContain("private-customer-key");
      expect(body).toContain(`key ${publicKey}`);
      await invoke({ action: "submit", attemptId: runId, previewDigest });
      const submission = mocks.runGh.mock.calls.find(([args]) => args[0] === "api");
      expect(submission?.[1]?.input?.toString()).not.toContain("private-customer-key");
    },
  );

  it.each([
    {
      check: "core/doctor/runtime-tool-schemas",
      code: "doctor-failed",
      affectedKey: "mcp.servers",
      message: "connect ECONNREFUSED",
      publicMessage: "ECONNREFUSED",
    },
    {
      check: "readyz",
      code: "readyz-unhealthy",
      message: "Gateway readiness endpoint returned HTTP 503; expected HTTP 200.",
      publicMessage: "Gateway readiness endpoint returned HTTP 503; expected HTTP 200.",
    },
    {
      check: "package-install",
      code: "EACCES",
      message: "npm error code EACCES",
      publicMessage: "EACCES",
    },
    {
      check: "package-swap",
      code: "Error",
      message: "ENOENT: rollback launcher backup missing",
      publicMessage: "ENOENT",
    },
    {
      check: "managed-service",
      code: "systemd-user-bus-unavailable",
      message: "Connection refused to systemd user bus",
      publicMessage: "Connection refused",
    },
    {
      check: "plugin-update",
      code: "incompatible_plugin_api",
      pluginId: "discord",
      message: "Plugin requires a newer host API.",
      publicMessage: "[redacted-diagnostic]",
    },
  ])(
    "retains $check through the ledger, local summary and public preview",
    async ({ publicMessage, ...fact }) => {
      createUpdateRun({ runId, trigger: "control-ui" });
      recordUpdateRunPhase(runId, "validating", {
        step: {
          step: "failing check",
          status: "failed",
          detail: "private-raw-log",
          failureFacts: [fact],
        },
      });
      for (const step of [
        "package rollback",
        "repairing",
        "repair attempt 1",
        "repair attempt 2",
      ]) {
        recordUpdateRunStep(runId, { step, status: "failed" });
      }
      for (const step of ["global install rollback", "global install backup retention"]) {
        recordUpdateRunStep(runId, {
          step,
          status: "failed",
          failureFacts: [
            {
              check: "package-swap",
              code: "swap-failed",
              message: "Rollback verification timed out",
            },
          ],
        });
      }
      finishUpdateRun(runId, { status: "failed", reason: "update-failed" });
      const recorded = getUpdateRun(runId)!;
      expect(recorded.steps.find((step) => step.step === "failing check")?.failureFacts).toEqual([
        fact,
      ]);
      const local = renderUpdateRunReport(recorded).lines.join("\n");
      const { body } = await preview();
      expect(local.match(/^Failed:/gmu)).toHaveLength(3);
      expect(body.match(/^- Failed phase /gmu)).toHaveLength(3);
      expect(local).toContain("Failed: global install backup retention");
      expect(body).toContain("Failing check package-swap (swap-failed)");
      for (const text of [local, body]) {
        expect(text).toContain(`Failing check ${fact.check} (${fact.code})`);
        if (fact.affectedKey) {
          expect(text).toContain(fact.affectedKey);
        }
        if (fact.pluginId) {
          expect(text).toContain(fact.pluginId);
        }
      }
      expect(local).toContain(fact.message);
      expect(body).toContain(`: ${publicMessage}\n`);
      expect(body).not.toContain("private-raw-log");
    },
  );
  it.each([
    { reason: "dirty", reportable: true },
    { reason: "not-git-install", reportable: true },
    { reason: "already-current", reportable: false },
    { reason: "dry-run", reportable: false },
    { reason: "cancelled", reportable: false },
  ])(
    "keeps skipped $reason reporting aligned with the actual outcome",
    async ({ reason, reportable }) => {
      createUpdateRun({ runId, trigger: "control-ui" });
      finishUpdateRun(runId, { status: "skipped", reason });
      const respond = await invoke({ action: "preview", attemptId: runId });
      if (reportable) {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            status: "ready",
            attemptId: runId,
            body: expect.stringContaining(reason),
          }),
        );
      } else {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      }
      expect(mocks.runGh).not.toHaveBeenCalled();
      expect(await reportFiles()).toEqual([]);
    },
  );

  it.each(["failed", "rolled-back"] as const)(
    "previews %s without a sentinel and never treats status as verified rollback",
    async (status) => {
      recordFailure(status);
      const result = await preview();
      expect(result.body).toContain("f".repeat(40));
      expect(result.body).toContain("build");
      expect(result.body).toContain("2026.9.1");
      expect(result.body).toContain("2026.9.2");
      expect(result.body).toContain("Recovery outcome: not recorded");
      expect(result.body).not.toContain("private-");
      expect(Buffer.byteLength(result.body)).toBeLessThan(16_000);
      expect(await reportFiles()).toEqual([]);
      expect(mocks.runGh).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "includes rollback/exit evidence only from a matching final sentinel: %s",
    async (matches) => {
      recordFailure();
      const sentinel = matchingSentinel();
      mocks.sentinel.mockResolvedValue({
        ...sentinel,
        stats: {
          ...sentinel.stats,
          runId: matches ? runId : "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        },
      });
      const result = await preview();
      expect(result.body.includes("verified safe to restart")).toBe(matches);
      expect(result.body.includes("exit 2")).toBe(matches);
      expect(result.body).not.toContain("private-");
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
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(await reportFiles()).toEqual([]);
      expect(mocks.runGh).not.toHaveBeenCalled();
    },
  );

  it("reuses the durable created URL on duplicate submission without repeating transport", async () => {
    recordFailure();
    const { previewDigest } = await preview();
    const params = { action: "submit", attemptId: runId, previewDigest };
    const first = await invoke(params);
    const second = await invoke(params);
    expect(first).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "created", url: issueUrl }),
    );
    expect(second).toHaveBeenCalledWith(true, expect.objectContaining({ url: issueUrl }));
    expect(mocks.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth", "api"]);
    expect(await reportFiles()).toEqual([]);
  });

  it.each([
    { outcome: "created", changedPreview: false },
    { outcome: "created", changedPreview: true },
    { outcome: "pending", changedPreview: false },
    { outcome: "pending", changedPreview: true },
  ] as const)(
    "reuses CLI $outcome across Gateway reconnect, changed preview: $changedPreview",
    async ({ outcome, changedPreview }) => {
      recordFailure();
      mocks.runGh.mockImplementation(async (args) => {
        if (args[0] === "auth") {
          return { started: true, status: 0, stdout: Buffer.alloc(0) };
        }
        if (args[0] === "issue") {
          expect(args[1]).toBe("list");
          return { started: true, status: 0, stdout: Buffer.from("[]") };
        }
        expect(args[0]).toBe("api");
        return outcome === "created"
          ? { started: true, status: 0, stdout: Buffer.from(issueUrl) }
          : { started: true, status: 1, stdout: Buffer.alloc(0) };
      });
      const runtime = { log: vi.fn(), error: vi.fn() };
      await expect(
        runInteractiveUpdateFailureAction({
          attemptId: runId,
          env: process.env,
          result: {
            status: "error",
            mode: "git",
            reason: "build-failed",
            before: { version: "2026.9.1" },
            after: {
              version: changedPreview ? "2026.9.3" : "2026.9.2",
              upstreamRef: "f".repeat(40),
            },
            steps: [
              { name: "validating", command: "", cwd: "", durationMs: 0, exitCode: null },
              { name: "build", command: "", cwd: "", durationMs: 0, exitCode: null },
            ],
            durationMs: 1,
          },
          runtime,
        }),
      ).resolves.toBe("handled");
      expect(runtime.error).not.toHaveBeenCalled();
      const createPhases = () =>
        mocks.runGh.mock.calls.map(([args]) => args[0]).filter((kind) => kind !== "issue");
      expect(createPhases()).toEqual(["auth", "api"]);
      closeOpenClawStateDatabaseForTest();
      expect(readUpdateFailureReportReceipt(runId)).toMatchObject({ status: outcome });

      const { body, previewDigest } = await preview();
      if (!changedPreview) {
        expect(runtime.log).toHaveBeenCalledWith(body);
      }
      expect(readUpdateFailureReportReceipt(runId)?.previewDigest === previewDigest).toBe(
        !changedPreview,
      );
      const response = await invoke({ action: "submit", attemptId: runId, previewDigest });
      expect(response).toHaveBeenCalledWith(
        true,
        expect.objectContaining(
          outcome === "created" ? { status: "duplicate" } : { status: "pending" },
        ),
      );
      if (outcome === "created" && !changedPreview) {
        expect(response.mock.calls[0]?.[1]).toMatchObject({ url: issueUrl });
      } else {
        expect(response.mock.calls[0]?.[1]).not.toHaveProperty("url");
        expect(response.mock.calls[0]?.[1]).not.toHaveProperty("fallbackUrl");
      }
      expect(createPhases()).toEqual(["auth", "api"]);

      const nextRunId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      createUpdateRun({ runId: nextRunId, trigger: "cli" });
      finishUpdateRun(nextRunId, { status: "failed", reason: "build-failed" });
      const nextPreview = await invoke({ action: "preview", attemptId: nextRunId });
      const nextResult = nextPreview.mock.calls[0]?.[1];
      if (!isRecord(nextResult) || typeof nextResult.previewDigest !== "string") {
        throw new Error("Missing distinct-run report preview");
      }
      await invoke({
        action: "submit",
        attemptId: nextRunId,
        previewDigest: nextResult.previewDigest,
      });
      expect(createPhases()).toEqual(["auth", "api", "auth", "api"]);
      expect(readUpdateFailureReportReceipt(nextRunId)).toMatchObject({ status: outcome });
      expect(readUpdateFailureReportReceipt(runId)).toMatchObject({ status: outcome });
    },
  );

  it.each(["auth-preflight", "attempt-validation"] as const)(
    "refuses a retired connection during %s and permits explicit resubmission after reconnect",
    async (pauseAt) => {
      recordFailure();
      const connection = new AbortController();
      const authority: ClientAuthority = {
        connectionSignal: connection.signal,
        authenticatedUserProfile: {
          profileId: GATEWAY_OWNER_PROFILE_ID,
          displayName: null,
          hasAvatar: false,
          updatedAt: 0,
        },
      };
      const { previewDigest } = await preview(authority);
      const paused = createDeferred();
      const resume = createDeferred();
      mocks.runGh.mockImplementationOnce(async (args) => {
        expect(args[0]).toBe("auth");
        if (pauseAt === "auth-preflight") {
          paused.resolve();
          await resume.promise;
        } else {
          mocks.sentinel.mockImplementationOnce(async () => {
            paused.resolve();
            await resume.promise;
            return null;
          });
        }
        return { started: true, status: 0, stdout: Buffer.alloc(0) };
      });
      const params = { action: "submit", attemptId: runId, previewDigest };
      const submitting = invoke(params, () => true, authority);
      await paused.promise;
      // The host retires the socket without changing its admitted auth generation.
      connection.abort();
      resume.resolve();
      const respond = await submitting;
      expect(mocks.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth"]);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(readUpdateFailureReportReceipt(runId)).toBeNull();
      expect(await reportFiles()).toEqual([]);

      const reconnected = { ...authority, connectionSignal: new AbortController().signal };
      const retried = await invoke(params, () => true, reconnected);
      expect(retried).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "created", url: issueUrl }),
      );
      expect(mocks.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth", "auth", "api"]);
      expect(await reportFiles()).toEqual([]);
    },
  );

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
    expect(readUpdateFailureReportReceipt(runId)).toBeNull();
    expect(await reportFiles()).toEqual([]);
    expect(mocks.runGh).not.toHaveBeenCalled();
  });

  it("retains a confirmed created URL if the connection retires after issue creation", async () => {
    recordFailure();
    const connection = new AbortController();
    const authority: ClientAuthority = {
      internal: { operatorRoleActor: { kind: "system" } },
      connectionSignal: connection.signal,
    };
    const { previewDigest } = await preview(authority);
    mocks.runGh.mockImplementation(async (args) => {
      if (args[0] === "api") {
        connection.abort();
        return { started: true, status: 0, stdout: Buffer.from(issueUrl) };
      }
      return { started: true, status: 0, stdout: Buffer.alloc(0) };
    });
    const params = { action: "submit", attemptId: runId, previewDigest };
    await invoke(params, () => true, authority);
    closeOpenClawStateDatabaseForTest();
    expect(readUpdateFailureReportReceipt(runId)).toMatchObject({
      status: "created",
      url: issueUrl,
    });
    const reconnected = await invoke(params, () => true, {
      ...authority,
      connectionSignal: new AbortController().signal,
    });
    expect(reconnected).toHaveBeenCalledWith(true, expect.objectContaining({ url: issueUrl }));
    expect(mocks.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth", "api"]);
    expect(await reportFiles()).toEqual([]);
  });

  it.each(["replacement-run", "duplicate-finalization", "changed-sentinel"] as const)(
    "handles %s during auth preflight using authoritative final facts",
    async (change) => {
      recordFailure();
      mocks.sentinel.mockResolvedValue(matchingSentinel());
      const { previewDigest } = await preview();
      mocks.runGh.mockImplementation(async (args) => {
        if (args[0] === "api") {
          expect(change).toBe("duplicate-finalization");
          return { started: true, status: 0, stdout: Buffer.from(issueUrl) };
        }
        expect(args[0]).toBe("auth");
        if (change === "replacement-run") {
          createUpdateRun({ trigger: "control-ui" });
        } else if (change === "duplicate-finalization") {
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
        return { started: true, status: 0, stdout: Buffer.alloc(0) };
      });
      const respond = await invoke({ action: "submit", attemptId: runId, previewDigest });
      if (change === "duplicate-finalization") {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "created", url: issueUrl }),
        );
        expect(mocks.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth", "api"]);
      } else {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(mocks.runGh).toHaveBeenCalledOnce();
      }
      expect(await reportFiles()).toEqual([]);
    },
  );
});
