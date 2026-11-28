import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/users.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import type { RunGithubCli } from "../../../infra/github-issue.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunPhase,
} from "../../../infra/update-run-ledger.js";
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

const { updateReportHandler } = await import("../../server-methods/update-report.js");

const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const issueUrl = "https://github.com/openclaw/openclaw/issues/999999";
const createdResponse = { ok: true, payload: { status: "created", url: issueUrl } };
let stateDir = "";

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
        attemptId: runId,
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

describe("update report live authority boundary", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-report-authority-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createUpdateRun({
      runId,
      trigger: "control-ui",
      before: { version: "2026.8.1" },
    });
    recordUpdateRunPhase(runId, "validating", {
      step: { step: "doctor", status: "failed", exitCode: 1 },
    });
    finishUpdateRun(runId, {
      status: "failed",
      reason: "doctor-failed",
      after: { version: "2026.8.2" },
    });
    mocks.submitGithubIssue.mockResolvedValue({ status: "created", url: issueUrl });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { force: true, recursive: true });
  });

  it.each(["gateway-owner", "system-admin"] as const)(
    "submits a report with delegated %s authority",
    async (authority) => {
      const transport = await vi.importActual<typeof import("../../../infra/github-issue.js")>(
        "../../../infra/github-issue.js",
      );
      const client = createOperatorWsClient({ connId: `report-runtime-${authority}` });
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
        if (args[0] === "issue") {
          return { started: true, status: 0, stdout: Buffer.from("[]") };
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
      mocks.submitGithubIssue.mockImplementationOnce((issue) =>
        transport.submitGithubIssue(issue, runGh),
      );
      try {
        expect(validateAuthority(identity)).toBe(true);
        const previewDigest = await preview("runtime-preview");
        const finished = waitForNextHandler();
        const dispatch = submit("runtime-submit", previewDigest);
        await entered.promise;
        expect(validateAuthority(identity)).toBe(true);
        expect(client.invalidated).not.toBe(true);
        expect(client.connectionSignal?.aborted).not.toBe(true);
        released.resolve();
        await finished;
        await dispatch;

        expect(validateAuthority(identity)).toBe(true);
        expect(mocks.submitGithubIssue).toHaveBeenCalledOnce();

        expect(runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth", "issue", "api"]);
        const response = await harness.awaitResponseFrame("runtime-submit");
        expect(response).toMatchObject(createdResponse);
        expect(harness.close).not.toHaveBeenCalled();
      } finally {
        released.resolve();
        releaseAgentRunDelegatedAuthority(claim);
      }
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

      if (!allowed) {
        expect(response).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
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
      }
      expect(mocks.submitGithubIssue).not.toHaveBeenCalled();
      expect(mocks.reconcileGithubIssue).not.toHaveBeenCalled();
    },
  );

  it.each(["shared-auth", "invalidated"] as const)(
    "rejects the next report request after %s authority is revoked",
    async (change) => {
      const { harness, revoke, preview, submit } = authorityHarness(change, `report-${change}`);
      const previewDigest = await preview("preview");

      revoke();
      await submit("denied", previewDigest);

      expect(harness.close).toHaveBeenCalledWith(4001, authorityCloseReasons[change]);
      expect(mocks.submitGithubIssue).not.toHaveBeenCalled();
      expect(mocks.reconcileGithubIssue).not.toHaveBeenCalled();
      expect(harness.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: "denied", ok: true }),
      );
    },
  );
});
