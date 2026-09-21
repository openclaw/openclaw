import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import type { SqliteWorkerNativeSettlementOwner } from "../../infra/sqlite-worker-operation-settlement.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { prepareTaskRegistryRead } from "../../tasks/task-registry-read.js";
import { getTaskRegistryStore } from "../../tasks/task-registry.store.js";
import { createTaskFixture } from "../../tasks/task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { coreGatewayHandlers, handleGatewayRequest } from "../server-methods.js";
import * as sharing from "../session-sharing.js";
import * as sessionUtils from "../session-utils.js";
import * as resolution from "./artifacts-session-resolution.js";
import { assistantFileMessage } from "./artifacts.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const boundaries = vi.hoisted(() => ({
  visit: vi.fn<typeof import("../session-transcript-readers.js").visitSessionMessagesAsync>(),
  managed:
    vi.fn<
      typeof import("../managed-image-attachments.js").resolveManagedOutgoingMediaArtifactDownload
    >(),
  managedUrl:
    vi.fn<
      typeof import("../managed-image-attachments.js").resolveManagedOutgoingMediaUrlDownload
    >(),
}));

vi.mock("../session-transcript-readers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-transcript-readers.js")>()),
  visitSessionMessagesAsync: boundaries.visit,
}));
vi.mock("../managed-image-attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../managed-image-attachments.js")>()),
  resolveManagedOutgoingMediaArtifactDownload: boundaries.managed,
  resolveManagedOutgoingMediaUrlDownload: boundaries.managedUrl,
}));

beforeEach(() => {
  // Shared workers clear agent listeners independently of the retained task registry.
  resetTaskRegistryForTests({ persist: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  boundaries.visit.mockReset();
  boundaries.managed.mockReset();
  boundaries.managedUrl.mockReset();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
});

const methods = ["artifacts.list", "artifacts.get", "artifacts.download"] as const;
type Method = (typeof methods)[number];
const changes = [
  "request canceled",
  "device revoked",
  "caller replaced",
  "opaque guard refused",
  "reconnected",
] as const;
type Change = (typeof changes)[number];
const registry = createGatewayMethodRegistry(
  createCoreGatewayMethodDescriptors(coreGatewayHandlers),
);
const sessionKey = "agent:main:artifact-request-authority";
const managedId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";

async function exercise(
  method: Method,
  change: Change,
  secondPreparation = false,
  disclosureBoundary?: "transcript" | "managed" | "url",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "artifact-request-authority", updatedAt: 1 },
    );
    const task = createTaskFixture("cli", {
      runId: "artifact-request-authority",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      task: "Prepare artifacts under retained request authority",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
    });
    await prepareTaskRegistryRead();
    const requestController = new AbortController();
    const connection = new AbortController();
    const context = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
    const client: GatewayClient = {
      connId: "artifact-authority-original-connection",
      connectionSignal: connection.signal,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        role: "operator",
        scopes: ["operator.read"],
      },
    };
    let current = true;
    let guardAllowed = true;
    const refusal = new Error(`Synthetic artifact ${change}`);
    const captured = captureGatewayDeviceRevocation(
      context,
      { deviceId: "artifact-device", role: "operator" },
      () => current,
      connection.signal,
    );
    const guard = vi.fn(() => {
      if (!guardAllowed) {
        throw refusal;
      }
    });
    const respond = vi.fn();
    const invoke = (params: Record<string, unknown>, selectedMethod: Method = method) =>
      handleGatewayRequest({
        req: { type: "req", id: selectedMethod, method: selectedMethod, params },
        client,
        context,
        methodRegistry: registry,
        signal: requestController.signal,
        hasCurrentClientAuthority: captured.isCurrent,
        sessionMutationCommitGuard: guard,
        isWebchatConnect: () => false,
        respond,
      });
    const message =
      secondPreparation || disclosureBoundary === "managed"
        ? {
            role: "assistant",
            content: [{ type: "image", artifactId: managedId, title: "managed.png" }],
            __openclaw: { seq: 2, taskId: task.taskId },
          }
        : disclosureBoundary === "url"
          ? {
              role: "assistant",
              content: [
                { type: "file", title: "result.txt", url: "https://example.invalid/result" },
              ],
              __openclaw: { seq: 2, taskId: task.taskId },
            }
          : assistantFileMessage({ title: "result.txt", taskId: task.taskId });
    boundaries.visit.mockImplementation(async (_scope, visit) => {
      visit(message, 2);
      return 1;
    });
    boundaries.managed.mockResolvedValue({
      artifactId: managedId,
      sessionKey,
      type: "image",
      title: "managed.png",
      url: "https://example.invalid/synthetic-artifact",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    boundaries.managedUrl.mockResolvedValue(null);
    await invoke({ sessionKey }, "artifacts.list");
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const artifactId: unknown = respond.mock.calls[0]?.[1]?.artifacts?.[0]?.id;
    if (typeof artifactId !== "string") {
      throw new Error("Expected the synthetic transcript artifact");
    }
    respond.mockClear();
    boundaries.visit.mockClear();
    guard.mockClear();
    const changeAuthority = () => {
      if (change === "request canceled") {
        requestController.abort(refusal);
      } else if (change === "device revoked") {
        invalidateGatewayDeviceRevocation(context, "artifact-device", "operator");
      } else if (change === "caller replaced") {
        current = false;
      } else if (change === "opaque guard refused") {
        guardAllowed = false;
      } else {
        connection.abort();
      }
    };
    if (disclosureBoundary) {
      const entered = createDeferred();
      const release = createDeferred();
      const hold = async () => {
        entered.resolve();
        await release.promise;
      };
      if (disclosureBoundary === "transcript") {
        boundaries.visit.mockImplementationOnce(async (_scope, visit) => {
          visit(message, 2);
          await hold();
          return 1;
        });
      } else if (disclosureBoundary === "managed") {
        boundaries.managed.mockImplementationOnce(async () => {
          await hold();
          return {
            artifactId: managedId,
            sessionKey,
            type: "image",
            title: "managed.png",
            url: "https://example.invalid/synthetic-artifact",
            expiresAt: "2030-01-01T00:00:00.000Z",
          };
        });
      } else {
        boundaries.managedUrl.mockImplementationOnce(async () => {
          await hold();
          return null;
        });
      }
      const outcome = Promise.allSettled([
        invoke({ taskId: task.taskId, ...(method === "artifacts.list" ? {} : { artifactId }) }),
      ]);
      try {
        await entered.promise;
        expect(respond).not.toHaveBeenCalled();
        changeAuthority();
        release.resolve();
        const settled = await outcome;
        if (change === "reconnected") {
          expect(settled).toEqual([{ status: "fulfilled", value: undefined }]);
          expect(respond.mock.calls[0]?.[0]).toBe(true);
        } else {
          expect(settled).toMatchObject([{ status: "rejected", reason: refusal }]);
          expect(respond).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await outcome;
        captured.release();
        closeGatewayDeviceRevocation(context);
        await closeOpenClawStateDatabaseAsync();
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      return;
    }
    const sessionReads = vi.spyOn(sessionUtils, "loadGatewaySessionEntryReadOnly");
    const sharingReads = vi.spyOn(sharing, "resolveSessionSharingTarget");
    const preparing = createDeferred();
    const committed = createDeferred();
    const release = createDeferred();
    const prepare = resolution.prepareArtifactSessionResolution;
    let preparations = 0;
    vi.spyOn(resolution, "prepareArtifactSessionResolution").mockImplementation((query) => {
      if (query.taskId === task.taskId && ++preparations === (secondPreparation ? 2 : 1)) {
        preparing.resolve();
      }
      return prepare(query);
    });
    const store = getTaskRegistryStore();
    const mutate = store.runAgentEventMutationAsync.bind(store);
    let nativeOwner: SqliteWorkerNativeSettlementOwner | undefined;
    let outcome: Promise<PromiseSettledResult<void>[]> | undefined;
    const startRequest = () => {
      outcome = Promise.allSettled([
        invoke({ taskId: task.taskId, ...(method === "artifacts.list" ? {} : { artifactId }) }),
      ]);
    };
    const writes = vi
      .spyOn(store, "runAgentEventMutationAsync")
      .mockImplementation(async (stateContext, input, assertCurrent, onGranted) => {
        const receipt = await mutate(stateContext, input, assertCurrent, (owner) => {
          nativeOwner = owner;
          onGranted(owner);
          if (!secondPreparation) {
            startRequest();
          }
        });
        committed.resolve();
        // Native settlement is real; publication remains owned until this result returns.
        await release.promise;
        return receipt;
      });
    const emit = () =>
      emitAgentEvent({
        runId: task.runId!,
        stream: "tool",
        data: { phase: "start", name: "authority-fence" },
      });
    if (secondPreparation) {
      boundaries.visit.mockImplementationOnce(async (_scope, visit) => {
        visit(message, 2);
        emit();
        return 1;
      });
    }
    try {
      if (secondPreparation) {
        startRequest();
      } else {
        emit();
      }
      await committed.promise;
      await preparing.promise;
      expect(nativeOwner?.settlement?.kind).toBe("completed");
      expect(nativeOwner?.committed?.facts).toBeDefined();
      expect(respond).not.toHaveBeenCalled();
      expect(guard).toHaveBeenCalled();
      const readsBeforeRelease = {
        session: sessionReads.mock.calls.length,
        sharing: sharingReads.mock.calls.length,
        transcript: boundaries.visit.mock.calls.length,
      };
      expect(readsBeforeRelease).toEqual(
        secondPreparation
          ? { session: 1, sharing: 1, transcript: 1 }
          : { session: 0, sharing: 0, transcript: 0 },
      );
      changeAuthority();
      expect(captured.isCurrent()).toBe(
        change !== "device revoked" && change !== "caller replaced",
      );
      release.resolve();
      const settled = await outcome;
      expect(writes).toHaveBeenCalledOnce();
      if (change === "reconnected") {
        expect(settled).toEqual([{ status: "fulfilled", value: undefined }]);
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(boundaries.visit).toHaveBeenCalledOnce();
        if (secondPreparation) {
          expect(boundaries.managed).toHaveBeenCalledOnce();
        }
      } else {
        expect(settled).toMatchObject([
          {
            status: "rejected",
            reason:
              change === "request canceled" || change === "opaque guard refused"
                ? refusal
                : { message: "Gateway requester authority changed" },
          },
        ]);
        expect(respond).not.toHaveBeenCalled();
        expect(sessionReads).toHaveBeenCalledTimes(readsBeforeRelease.session);
        expect(sharingReads).toHaveBeenCalledTimes(readsBeforeRelease.sharing);
        expect(boundaries.visit).toHaveBeenCalledTimes(readsBeforeRelease.transcript);
        expect(boundaries.managed).not.toHaveBeenCalled();
        expect(boundaries.managedUrl).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      await outcome;
      await prepareTaskRegistryRead();
      captured.release();
      closeGatewayDeviceRevocation(context);
      await closeOpenClawStateDatabaseAsync();
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
}

describe("registered artifact request authority after task preparation", () => {
  it.each(methods.flatMap((method) => changes.map((change) => ({ method, change }))))(
    "checks $change after $method preparation",
    async ({ method, change }) => exercise(method, change),
  );

  it.each(changes)("checks %s again before the managed-download capability", async (change) => {
    await exercise("artifacts.download", change, true);
  });
});

describe("registered artifact response authority after asynchronous reads", () => {
  const frames = [
    ...methods.map((method) => ({ method, boundary: "transcript" as const })),
    { method: "artifacts.download" as const, boundary: "managed" as const },
    { method: "artifacts.download" as const, boundary: "url" as const },
  ];
  const outcomes = ["request canceled", "opaque guard refused", "reconnected"] as const;
  it.each(
    frames.flatMap((frame) =>
      outcomes.map((change) => ({ method: frame.method, boundary: frame.boundary, change })),
    ),
  )("checks $change after $method $boundary read", async ({ method, boundary, change }) =>
    exercise(method, change, false, boundary),
  );
});
