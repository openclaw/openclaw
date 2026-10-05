import { afterEach, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { createReplyTurnParticipants } from "../auto-reply/reply/reply-run-registry.tool-authority.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import { getCanonicalUserPreferences } from "../state/user-preferences.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { runWithOperatorToolGatewayAuthority } from "./operator-tool-gateway-authority.js";
import { themeHandlers } from "./server-methods/themes.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  await closeMcpLoopbackServer();
  vi.restoreAllMocks();
  for (const release of cleanup.splice(0).toReversed()) {
    await release();
  }
});

it("dispatches a later grant to a real preference commit without inheriting creator authority", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "mcp-dispatch-" });
  cleanup.push(() => state.cleanup());
  const cfg = { plugins: { enabled: false }, tools: { allow: ["theme"] } };
  setRuntimeConfigSnapshot(cfg);
  const context = createContext();
  context.getRuntimeConfig = () => cfg;
  context.resolveGatewayContext = () => context;
  const registry = createGatewayMethodRegistry([
    {
      name: "themes.set",
      scope: "operator.write",
      owner: { kind: "core", area: "themes" },
      handler: themeHandlers["themes.set"]!,
    },
  ]);
  context.getGatewayMethodRegistry = () => registry;

  const creator = new AbortController();
  await runWithOperatorToolGatewayAuthority(
    { scopes: ["operator.write"], signal: creator.signal },
    () => ensureMcpLoopbackServer(),
  );
  creator.abort(new Error("listener creator completed"));
  const runtime = getActiveMcpLoopbackRuntime()!;

  const mint = async (id: string, scopes: string[]) => {
    const client = createOperatorClient({ profileName: id, scopes });
    const profileId = client.authenticatedUserProfile!.profileId;
    let current = true;
    const authority = createAdmittedRunOperatorAuthority({
      profileId,
      scopes,
      assertCurrent: () => {
        if (!current) {
          throw new Error("caller authority revoked");
        }
      },
    });
    const participants = createReplyTurnParticipants({
      operatorAuthority: authority,
      senderId: profileId,
      senderName: id,
    });
    cleanup.push(() => participants.close());
    const admission = prepareAgentRunAdmission({
      cfg,
      operationalRunInstance: createOperationalRunInstanceRef(id),
      operatorAuthority: authority,
      facts: {
        runId: id,
        agentId: "main",
        ingress: { kind: "system", boundary: "mcp-effect-test", state: "present" },
      },
    });
    cleanup.push(() => admission.close());
    const admittedRunContext = await admission.admit("gateway", `gateway-${id}`);
    bindGatewayContextResolver(admittedRunContext, () => context);
    const grant = mintMcpLoopbackClientGrant({
      runtimeOwnerToken: runtime.ownerToken,
      admittedRunContext,
      personalToolParticipants: participants,
      context: {
        sessionKey: "agent:main:dispatch-effect",
        senderIsOwner: true,
        workspaceDir: state.workspaceDir,
        toolsAllow: ["theme"],
        modelHasVision: false,
        nodeExecAllowed: false,
      },
    });
    const captureKey = `capture-${id}`;
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: runtime.ownerToken,
        captureKey,
      }),
    ).toBeTruthy();
    return {
      token: grant.token,
      captureKey,
      profileId,
      revoke: () => {
        current = false;
      },
    };
  };
  const call = async (grant: { token: string; captureKey: string }, mode = "dark") => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "content-type": "application/json",
        "x-openclaw-cli-capture-key": grant.captureKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "theme", arguments: { action: "set", mode } },
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const preference = async (profileId: string) =>
    (await getCanonicalUserPreferences(profileId))?.entries["ui.themeMode"];

  const allowed = await mint("allowed", ["operator.write"]);
  const allowedResponse = await call(allowed);
  expect(allowedResponse, JSON.stringify(allowedResponse)).toMatchObject({
    status: 200,
    body: { result: { isError: false } },
  });
  expect(await preference(allowed.profileId)).toBe("dark");

  const restricted = await mint("restricted", ["operator.read"]);
  expect(await call(restricted)).toMatchObject({
    status: 200,
    body: {
      result: { isError: true, content: [{ text: expect.stringContaining("missing scope") }] },
    },
  });
  expect(await preference(restricted.profileId)).toBeUndefined();

  // Revoke at the real SQLite worker's commit checkpoint, after dispatch has passed.
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  let commitReached = false;
  const checkpoint = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          commitReached = true;
          allowed.revoke();
        }
        admit(request, grant);
      }, attachment),
    );
  expect(await call(allowed, "light")).toMatchObject({
    status: 200,
    body: { result: { isError: true } },
  });
  expect(commitReached).toBe(true);
  checkpoint.mockRestore();
  expect(await preference(allowed.profileId)).toBe("dark");
  expect(await call(allowed, "light")).toMatchObject({ status: 401 });
  expect(await preference(allowed.profileId)).toBe("dark");
});
