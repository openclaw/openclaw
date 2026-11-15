import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
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
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import * as resolution from "./artifacts-session-resolution.js";
import { assistantFileMessage } from "./artifacts.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const boundaries = vi.hoisted(() => ({
  visit:
    vi.fn<
      typeof import("../session-transcript-native.test-support.js").visitSessionMessagesAsync
    >(),
  managed:
    vi.fn<
      typeof import("../managed-image-attachments.js").resolveManagedOutgoingMediaArtifactDownload
    >(),
  managedUrl:
    vi.fn<
      typeof import("../managed-image-attachments.js").resolveManagedOutgoingMediaUrlDownload
    >(),
}));

vi.mock("../session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-transcript-readers.js")>();
  const { withArtifactFixtureReader } = await import("./artifacts.test-support.js");
  return withArtifactFixtureReader(actual, boundaries.visit);
});
vi.mock("../managed-image-attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../managed-image-attachments.js")>()),
  resolveManagedOutgoingMediaArtifactDownload: boundaries.managed,
  resolveManagedOutgoingMediaUrlDownload: boundaries.managedUrl,
}));

afterEach(() => {
  vi.restoreAllMocks();
  boundaries.visit.mockReset();
  boundaries.managed.mockReset();
  boundaries.managedUrl.mockReset();
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
const runId = "artifact-request-authority-run";
const managedId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
const agentConfig = (agentId: string): OpenClawConfig => ({
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId } },
    entries: { main: {}, work: {} },
  },
});

async function exercise(
  method: Method,
  change: Change,
  secondPreparation = false,
  disclosureBoundary?: "transcript" | "managed" | "url",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "artifact-request-authority", updatedAt: 1 },
    );
    const requestController = new AbortController();
    const connection = new AbortController();
    const context = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
    const client: GatewayClient = {
      connId: "artifact-authority-original-connection",
      connectionSignal: connection.signal,
      connect: gatewayConnect(["operator.read"]),
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
    const guard = () => {
      if (!guardAllowed) {
        throw refusal;
      }
    };
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
            __openclaw: { seq: 2, runId },
          }
        : disclosureBoundary === "url"
          ? {
              role: "assistant",
              content: [
                { type: "file", title: "result.txt", url: "https://example.invalid/result" },
              ],
              __openclaw: { seq: 2 },
            }
          : assistantFileMessage({ title: "result.txt" });
    boundaries.visit.mockImplementation(async (_scope, visit) => {
      visit(message, 2);
      return 1;
    });
    const managedDownload = {
      artifactId: managedId,
      sessionKey,
      type: "image" as const,
      title: "managed.png",
      url: "https://example.invalid/synthetic-artifact",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    boundaries.managed.mockResolvedValue(managedDownload);
    boundaries.managedUrl.mockResolvedValue(null);
    await invoke({ sessionKey }, "artifacts.list");
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const artifactId: unknown = respond.mock.calls[0]?.[1]?.artifacts?.[0]?.id;
    if (typeof artifactId !== "string") {
      throw new Error("Expected the synthetic transcript artifact");
    }
    respond.mockClear();
    boundaries.visit.mockClear();
    const changeAuthority = {
      "request canceled": () => requestController.abort(refusal),
      "device revoked": () =>
        invalidateGatewayDeviceRevocation(context, "artifact-device", "operator"),
      "caller replaced": () => {
        current = false;
      },
      "opaque guard refused": () => {
        guardAllowed = false;
      },
      reconnected: () => connection.abort(),
    };
    const entered = createDeferred();
    const release = createDeferred();
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
    if (disclosureBoundary) {
      if (disclosureBoundary === "transcript") {
        boundaries.visit.mockImplementationOnce(async (_scope, visit) => {
          visit(message, 2);
          await hold();
          return 1;
        });
      } else if (disclosureBoundary === "managed") {
        boundaries.managed.mockImplementationOnce(async () => {
          await hold();
          return managedDownload;
        });
      } else {
        boundaries.managedUrl.mockImplementationOnce(async () => {
          await hold();
          return null;
        });
      }
    } else {
      const prepare = resolution.prepareArtifactSessionResolution;
      let preparations = 0;
      vi.spyOn(resolution, "prepareArtifactSessionResolution").mockImplementation(async (query) => {
        const prepared = await prepare(query);
        if (++preparations === (secondPreparation ? 2 : 1)) {
          await hold();
        }
        return prepared;
      });
    }
    const outcome = invoke({
      sessionKey,
      ...(secondPreparation ? { runId } : {}),
      ...(method === "artifacts.list" ? {} : { artifactId }),
      ...(method === "artifacts.download" && disclosureBoundary === "transcript"
        ? { transport: "http" }
        : {}),
    });
    void outcome.catch(() => {});
    try {
      await entered.promise;
      expect(respond).not.toHaveBeenCalled();
      const transcriptReadsBeforeRelease = boundaries.visit.mock.calls.length;
      if (!disclosureBoundary) {
        expect(transcriptReadsBeforeRelease).toBe(secondPreparation ? 1 : 0);
      }
      changeAuthority[change]();
      release.resolve();
      if (change === "reconnected") {
        await expect(outcome).resolves.toBeUndefined();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        if (method === "artifacts.download" && disclosureBoundary === "transcript") {
          expect(respond.mock.calls[0]?.[1]).toMatchObject({
            encoding: "base64",
            data: "aGVsbG8=",
          });
          expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("url");
        }
      } else {
        await expect(outcome).rejects.toMatchObject(
          disclosureBoundary || change === "request canceled" || change === "opaque guard refused"
            ? refusal
            : { message: "Gateway requester authority changed" },
        );
        expect(respond).not.toHaveBeenCalled();
        if (!disclosureBoundary) {
          expect(boundaries.visit).toHaveBeenCalledTimes(transcriptReadsBeforeRelease);
          expect(boundaries.managed).not.toHaveBeenCalled();
          expect(boundaries.managedUrl).not.toHaveBeenCalled();
        }
      }
    } finally {
      release.resolve();
      await outcome.catch(() => {});
      captured.release();
      closeGatewayDeviceRevocation(context);
      await closeOpenClawStateDatabaseAsync();
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
}

describe("registered artifact request authority after session preparation", () => {
  it.each(methods)("uses the current system agent after preparing %s", async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      let config = agentConfig("main");
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const readers = await import("../session-transcript-native.test-support.js");
      boundaries.visit.mockImplementation(readers.visitSessionMessagesAsync);
      const client: GatewayClient = {
        connId: "artifact-default-agent",
        connect: gatewayConnect(["operator.read"]),
      };
      const request = async (selectedMethod: Method, params: Record<string, unknown>) => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: selectedMethod, method: selectedMethod, params },
          client,
          context: { getRuntimeConfig: () => config } as GatewayRequestContext,
          methodRegistry: registry,
          isWebchatConnect: () => false,
          respond,
        });
        return respond;
      };
      for (const agentId of ["main", "work"]) {
        const scope = {
          agentId,
          sessionKey: `agent:${agentId}:main`,
          sessionId: `artifact-${agentId}`,
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        await appendTranscriptMessage(scope, {
          message: assistantFileMessage({ title: `${agentId}.txt` }),
        });
      }
      const listed = await request("artifacts.list", { sessionKey: "agent:work:main" });
      expect(listed.mock.calls[0]?.[0]).toBe(true);
      const artifactId: unknown = listed.mock.calls[0]?.[1]?.artifacts?.[0]?.id;
      if (typeof artifactId !== "string") {
        throw new Error("Expected the work agent artifact");
      }
      const prepare = resolution.prepareArtifactSessionResolution;
      vi.spyOn(resolution, "prepareArtifactSessionResolution").mockImplementation(async (query) => {
        const resolve = await prepare(query);
        config = agentConfig("work");
        setRuntimeConfigSnapshot(config);
        return resolve;
      });
      const response = await request(method, {
        sessionKey: "main",
        ...(method === "artifacts.list" ? {} : { artifactId }),
      });
      expect(response.mock.calls[0]?.[0]).toBe(true);
      const expected = { id: artifactId, sessionKey: "agent:work:main", title: "work.txt" };
      expect(response.mock.calls[0]?.[1]).toMatchObject(
        method === "artifacts.list" ? { artifacts: [expected] } : { artifact: expected },
      );
    });
  });

  it.each(changes)("checks %s after artifact session preparation", async (change) =>
    exercise("artifacts.download", change),
  );

  it("rechecks the guard before the managed-download capability", async () => {
    await exercise("artifacts.download", "opaque guard refused", true);
  });
});

describe("registered artifact response authority after asynchronous reads", () => {
  const frames = [
    ...methods.map((method) => ({ method, boundary: "transcript" as const })),
    { method: "artifacts.download" as const, boundary: "managed" as const },
    { method: "artifacts.download" as const, boundary: "url" as const },
  ];
  it.each([
    ...frames.map(({ method, boundary }) => ({
      method,
      boundary,
      change: "opaque guard refused" as const,
    })),
    ...(["request canceled", "reconnected"] as const).map((change) => ({
      method: "artifacts.download" as const,
      boundary: "transcript" as const,
      change,
    })),
  ])("checks $change after $method $boundary read", async ({ method, boundary, change }) =>
    exercise(method, change, false, boundary),
  );
});
