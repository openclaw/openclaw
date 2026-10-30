import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/users.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import type { GithubIssueSubmitHooks, RunGithubCli } from "../../../infra/github-issue.js";
import type { RestartSentinelPayload } from "../../../infra/restart-sentinel.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../state/openclaw-state-db.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../agent-runtime-approval-authority.js";
import { gatewayRequest } from "../../request-frame.test-support.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

const mocks = vi.hoisted(() => ({
  submitGithubIssue: vi.fn(),
  reconcileGithubIssue: vi.fn(),
  getLatest: vi.fn<() => RestartSentinelPayload | null>(),
  refreshLatest: vi.fn<() => Promise<RestartSentinelPayload | null>>(),
}));

vi.mock("../../../infra/github-issue.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/github-issue.js")>(
    "../../../infra/github-issue.js",
  );
  return {
    ...actual,
    submitGithubIssue: mocks.submitGithubIssue,
    reconcileGithubIssue: mocks.reconcileGithubIssue,
  };
});

vi.mock("../../server-update-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../server-update-sentinel.js")>(
    "../../server-update-sentinel.js",
  );
  return {
    ...actual,
    getLatestUpdateRestartSentinel: mocks.getLatest,
    refreshLatestUpdateRestartSentinel: mocks.refreshLatest,
  };
});

const { updateReportHandler } = await import("../../server-methods/update-report.js");

const failure: RestartSentinelPayload = {
  kind: "update",
  status: "error",
  ts: 500,
  stats: {
    handoffId: "authority-proof",
    mode: "npm",
    target: "openclaw@next",
    reason: "doctor-failed",
    before: { version: "2026.8.1" },
    after: { version: "2026.8.2" },
    steps: [
      { name: "doctor", command: "openclaw doctor --fix", durationMs: 10, log: { exitCode: 1 } },
    ],
    durationMs: 20,
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
  },
};

const issueUrl = "https://github.com/openclaw/openclaw/issues/999999";
const createdResponse = { ok: true, payload: { status: "created", url: issueUrl } };
const originalWriteFile = fs.writeFile.bind(fs);
let stateDir = "";

async function countReportReceipts(): Promise<number> {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  if (!existsSync(databasePath)) {
    return 0;
  }
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare(
          "SELECT COUNT(*) AS count FROM gateway_restart_sentinel WHERE sentinel_key LIKE 'update-failure-report:%'",
        )
        .get() as { count: number };
      return row.count;
    } finally {
      database.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function countReportFiles(): Promise<number> {
  try {
    return (await fs.readdir(path.join(stateDir, "update-reports"))).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function createReportHarness(
  client: ReturnType<typeof createOperatorWsClient>,
  getGeneration = () => "current",
) {
  let nextFinished = createDeferredCore();
  const handler: NonNullable<GatewayWsMessageHandlerParams["extraHandlers"][string]> = async (
    options,
  ) => {
    try {
      await updateReportHandler(options as never);
    } finally {
      const finished = nextFinished;
      nextFinished = createDeferredCore();
      finished.resolve();
    }
  };
  const harness = createDispatchTestHarness({
    extraHandlers: { "update.report": handler },
    buildRequestContext: () =>
      createDirectChatContext({
        getRuntimeConfig: () => ({}),
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      }),
    getRequiredSharedGatewaySessionGeneration: getGeneration,
  });
  const dispatch = (id: string, action: "preview" | "submit", previewDigest?: string) =>
    harness.dispatcher.dispatch(
      gatewayRequest(id, "update.report", {
        action,
        attemptId: "authority-proof",
        ...(previewDigest === undefined ? {} : { previewDigest }),
      }),
      client,
    );
  return {
    harness,
    waitForNextHandler: () => nextFinished.promise,
    dispatch,
    preview: async (id: string) => {
      await dispatch(id, "preview");
      const response = await harness.awaitResponseFrame(id);
      expect(response).toMatchObject({ ok: true, payload: { status: "ready" } });
      return (response.payload as { previewDigest: string }).previewDigest;
    },
    submit: (id: string, previewDigest: string) => dispatch(id, "submit", previewDigest),
  };
}

function grantReportAuthority(
  client: ReturnType<typeof createOperatorWsClient>,
  authority: "gateway-owner" | "system-admin",
): void {
  if (authority === "system-admin") {
    client.internal = { operatorRoleActor: { kind: "system" } };
    return;
  }
  client.authenticatedUserProfile = {
    profileId: GATEWAY_OWNER_PROFILE_ID,
    displayName: "Gateway owner",
    avatarRevision: "owner-avatar",
    hasAvatar: false,
    updatedAt: 1,
  };
}

function identifyNonOwner(client: ReturnType<typeof createOperatorWsClient>): void {
  client.authenticatedUserProfile = {
    profileId: "profile-non-owner",
    displayName: "Delegated operator",
    avatarRevision: "operator-avatar",
    hasAvatar: false,
    updatedAt: 1,
  };
}

const authorityCloseReasons = {
  "shared-auth": "gateway auth changed",
  invalidated: "client invalidated: device-token-revoked",
} as const;

function authorityHarness(change: keyof typeof authorityCloseReasons, connId: string) {
  let generation = "current";
  const client = createOperatorWsClient({ connId });
  grantReportAuthority(client, "system-admin");
  if (change === "shared-auth") {
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = generation;
  }
  return {
    client,
    ...createReportHarness(client, () => generation),
    revoke: () => {
      if (change === "shared-auth") {
        generation = "rotated";
      } else {
        client.invalidated = true;
        client.invalidatedReason = "device-token-revoked";
      }
    },
  };
}

async function expectNoReport() {
  expect(await countReportFiles()).toBe(0);
  expect(await countReportReceipts()).toBe(0);
}

describe("update report live authority boundary", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-report-authority-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    mocks.getLatest.mockReturnValue(failure);
    mocks.refreshLatest.mockResolvedValue(failure);
    mocks.submitGithubIssue.mockImplementation(
      async (_issue: unknown, _runGh: unknown, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        const commitIssueCreate = await hooks.beforeIssueCreate?.();
        commitIssueCreate?.();
        return {
          status: "created",
          url: issueUrl,
        };
      },
    );
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { force: true, recursive: true });
  });

  it.each([
    { authority: "gateway-owner", retire: true, boundary: "auth" },
    { authority: "system-admin", retire: true, boundary: "auth" },
    { authority: "gateway-owner", retire: false, boundary: "auth" },
    { authority: "system-admin", retire: false, boundary: "auth" },
    { authority: "gateway-owner", retire: true, boundary: "prepared" },
    { authority: "system-admin", retire: true, boundary: "prepared" },
  ] as const)(
    "revalidates delegated $authority authority at $boundary, retired=$retire",
    async ({ authority, retire, boundary }) => {
      const transport = await vi.importActual<typeof import("../../../infra/github-issue.js")>(
        "../../../infra/github-issue.js",
      );
      const client = createOperatorWsClient({ connId: `report-runtime-${authority}-${retire}` });
      grantReportAuthority(client, authority);
      client.usesSharedGatewayAuth = true;
      client.sharedGatewaySessionGeneration = "current";
      const claim = claimAgentRunDelegatedAuthority({
        instanceId: client.connId,
        runId: client.connId,
      });
      const identity = {
        kind: "agentRuntime" as const,
        agentId: "main",
        sessionKey: "agent:main:report-authority",
        operationalRunInstance: claim.operationalRunInstance,
        delegatedAuthority: { ...claim, kind: "local" as const },
      };
      client.internal = { ...client.internal, agentRuntimeIdentity: identity };
      const validateAuthority = createAgentRuntimeApprovalAuthorityValidator();
      const { harness, waitForNextHandler, preview, submit } = createReportHarness(client);
      const entered = createDeferredCore();
      const released = createDeferredCore();
      const runGh = vi.fn<RunGithubCli>(async (args) => {
        if (args[0] === "auth") {
          entered.resolve();
          await released.promise;
          return { started: true, status: 0, stdout: Buffer.alloc(0) };
        }
        expect(args).toContain("POST");
        expect(validateAuthority(identity)).toBe(true);
        return {
          started: true,
          status: 0,
          stdout: Buffer.from(
            "HTTP/2.0 201 Created\nhttps://github.com/openclaw/openclaw/issues/999999\n",
          ),
        };
      });
      mocks.submitGithubIssue.mockImplementationOnce(
        (issue, _runGh, hooks: GithubIssueSubmitHooks) =>
          transport.submitGithubIssue(issue, runGh, {
            ...hooks,
            beforeIssueCreate: async () => {
              if (!hooks.beforeIssueCreate) {
                throw new Error("expected the report preparation hook");
              }
              const commitIssueCreate = await hooks.beforeIssueCreate();
              if (boundary === "prepared" && retire) {
                queueMicrotask(() => releaseAgentRunDelegatedAuthority(claim));
              }
              return commitIssueCreate;
            },
          }),
      );
      try {
        expect(validateAuthority(identity)).toBe(true);
        const previewDigest = await preview("runtime-preview");
        expect(await countReportFiles()).toBe(0);
        const finished = waitForNextHandler();
        const dispatch = submit("runtime-submit", previewDigest);
        await entered.promise;
        if (retire && boundary === "auth") {
          expect(releaseAgentRunDelegatedAuthority(claim)).toBe(true);
        }
        expect(validateAuthority(identity)).toBe(!(retire && boundary === "auth"));
        expect(client.invalidated).not.toBe(true);
        expect(client.connectionSignal?.aborted).not.toBe(true);
        released.resolve();
        await finished;
        await dispatch;

        expect(validateAuthority(identity)).toBe(!retire);
        expect(mocks.submitGithubIssue).toHaveBeenCalledOnce();

        expect
          .soft(runGh.mock.calls.map(([args]) => args[0]))
          .toEqual(retire ? ["auth"] : ["auth", "api"]);
        expect.soft(await countReportReceipts()).toBe(retire ? 0 : 1);
        expect(await countReportFiles()).toBe(0);
        const response = await harness.awaitResponseFrame("runtime-submit");
        if (retire) {
          expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
          expect(harness.close).toHaveBeenCalledWith(4001, "agent runtime authority closed");
        } else {
          expect(response).toMatchObject(createdResponse);
          expect(harness.close).not.toHaveBeenCalled();
        }
      } finally {
        released.resolve();
        releaseAgentRunDelegatedAuthority(claim);
      }
    },
  );

  it.each(["identity", "same-identity-facts"] as const)(
    "refuses changed sentinel $0 during real shared auth preflight",
    async (change) => {
      const transport = await vi.importActual<typeof import("../../../infra/github-issue.js")>(
        "../../../infra/github-issue.js",
      );
      const client = createOperatorWsClient({ connId: `report-changed-${change}` });
      grantReportAuthority(client, "system-admin");
      const { harness, waitForNextHandler, preview, submit } = createReportHarness(client);
      const previewDigest = await preview(`preview-changed-${change}`);
      const entered = createDeferredCore();
      const released = createDeferredCore();
      const runGh = vi.fn<RunGithubCli>(async (args) => {
        expect(args[0]).toBe("auth");
        entered.resolve();
        await released.promise;
        return { started: true, status: 0, stdout: Buffer.alloc(0) };
      });
      mocks.submitGithubIssue.mockImplementationOnce((issue, _runGh, hooks) =>
        transport.submitGithubIssue(issue, runGh, hooks),
      );
      const finished = waitForNextHandler();
      const dispatch = submit(`changed-${change}`, previewDigest);
      await entered.promise;
      mocks.refreshLatest.mockResolvedValue({
        ...failure,
        stats: {
          ...failure.stats,
          ...(change === "identity" ? { handoffId: "replacement" } : { reason: "rollback-failed" }),
        },
      });
      released.resolve();
      await finished;
      await dispatch;

      expect(runGh).toHaveBeenCalledOnce();
      await expectNoReport();
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `changed-${change}`,
          ok: false,
          error: expect.objectContaining({ code: "INVALID_REQUEST" }),
        }),
      );
    },
  );

  it.each([
    { label: "operator.write", scopes: ["operator.write"], allowed: false },
    { label: "named administrator", scopes: ["operator.admin"], allowed: true },
  ])(
    "enforces the report publication boundary for an identified $label",
    async ({ scopes, allowed }) => {
      const client = createOperatorWsClient({
        connId: `report-denied-${scopes[0]}`,
        scopes,
      });
      identifyNonOwner(client);
      const { harness, dispatch, submit } = createReportHarness(client);

      await dispatch(`denied-${scopes[0]}`, "preview");
      const response = await harness.awaitResponseFrame(`denied-${scopes[0]}`);

      await expectNoReport();
      if (!allowed) {
        expect(response).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        expect(mocks.refreshLatest).not.toHaveBeenCalled();
      } else {
        expect(response).toMatchObject({ ok: true, payload: { status: "ready" } });
        const preview = response.payload;
        if (!isRecord(preview) || typeof preview.previewDigest !== "string") {
          throw new Error("Missing report preview");
        }
        await submit("browser-handoff", preview.previewDigest);
        const submitted = await harness.awaitResponseFrame("browser-handoff");
        expect(submitted).toMatchObject({ ok: true, payload: { status: "fallback" } });
        if (!isRecord(submitted.payload) || typeof submitted.payload.fallbackUrl !== "string") {
          throw new Error("Missing browser handoff");
        }
        const url = new URL(submitted.payload.fallbackUrl);
        expect(url.origin + url.pathname).toBe("https://github.com/openclaw/openclaw/issues/new");
        expect(url.searchParams.get("body")).toBe(preview.body);
        expect(url.searchParams.get("title")).toBe(preview.title);
        await submit("browser-repeat", preview.previewDigest);
        expect(await harness.awaitResponseFrame("browser-repeat")).toMatchObject({
          ok: true,
          payload: { status: "duplicate", fallbackUrl: submitted.payload.fallbackUrl },
        });
        expect(await countReportReceipts()).toBe(1);
        expect(await countReportFiles()).toBe(1);
      }
      expect(mocks.submitGithubIssue).not.toHaveBeenCalled();
      expect(mocks.reconcileGithubIssue).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["shared-auth", "auth-preflight"],
    ["invalidated", "auth-preflight"],
    ["shared-auth", "report-write"],
    ["invalidated", "report-write"],
    ["shared-auth", "sentinel-refresh"],
    ["invalidated", "sentinel-refresh"],
  ] as const)("blocks report side effects after %s closes during %s", async (change, stage) => {
    const {
      harness,
      waitForNextHandler,
      revoke,
      preview,
      dispatch: dispatchReport,
    } = authorityHarness(change, `report-${stage}-${change}`);
    const previewDigest = stage === "sentinel-refresh" ? undefined : await preview("preview");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let issueCreateCalls = 0;
    if (stage === "auth-preflight") {
      mocks.submitGithubIssue.mockImplementationOnce(
        async (_issue: unknown, _runGh: unknown, hooks: GithubIssueSubmitHooks) => {
          await hooks.afterAuthPreflight?.();
          entered.resolve();
          await release.promise;
          const commitIssueCreate = await hooks.beforeIssueCreate?.();
          commitIssueCreate?.();
          issueCreateCalls += 1;
          return { status: "created", url: issueUrl };
        },
      );
    } else if (stage === "report-write") {
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const result = await originalWriteFile(...args);
        if (
          typeof args[0] === "string" &&
          args[0].includes(`${path.sep}update-reports${path.sep}`)
        ) {
          entered.resolve();
          await release.promise;
        }
        return result;
      });
    } else {
      mocks.refreshLatest.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return failure;
      });
    }
    const finished = waitForNextHandler();
    const dispatch = dispatchReport(
      "denied",
      stage === "sentinel-refresh" ? "preview" : "submit",
      previewDigest,
    );
    await entered.promise;
    revoke();
    release.resolve();
    await finished;
    await dispatch;

    expect(harness.close).toHaveBeenCalledWith(4001, authorityCloseReasons[change]);
    expect(mocks.submitGithubIssue).toHaveBeenCalledTimes(stage === "auth-preflight" ? 1 : 0);
    if (stage === "auth-preflight") {
      expect(issueCreateCalls).toBe(0);
    }
    await expectNoReport();
    expect(harness.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "denied", ok: true }),
    );
  });
});
