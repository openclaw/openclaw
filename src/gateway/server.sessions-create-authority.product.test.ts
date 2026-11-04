import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createSessionsCreateTool } from "../agents/tools/sessions-create-tool.js";
import {
  listSessionEntryKeysReadOnly,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createReplyTurnParticipants } from "../sessions/session-controller.tool-authority.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { closeKernelFixture, createKernelFixture } from "./server-kernel.fixture-test-support.js";
import * as kernelOwner from "./server-kernel.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { startGatewayServerCore } from "./server-start.js";

// Real tool, in-process Gateway dispatcher, creation owner and SQLite persistence.
// Idle creation needs no model/provider fixture. Only the filesystem realpath I/O
// is held below; it still performs the real operation after the authority changes.
it("persists late-authorized creation and fences absent, read-only, revoked and replaced callers", async () => {
  const fixture = await createKernelFixture("sessions-create-invocation-authority", {
    layout: "home",
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
  });
  const { state } = fixture;
  let kernel: Awaited<ReturnType<typeof kernelOwner.createGatewayKernel>> | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  const cleanup: Array<() => void> = [];
  try {
    await fixture.configure({
      agents: {
        defaults: { workspace: state.workspaceDir, model: "unit-test/model", utilityModel: "" },
      },
      gateway: {
        roles: {
          default: "authority-writer",
          definitions: {
            "authority-writer": {
              agents: ["main"],
              scopes: ["operator.read", "operator.sessions.write"],
              sessions: { others: "none" },
            },
            "authority-reader": {
              agents: ["main"],
              scopes: ["operator.read"],
              sessions: { others: "none" },
            },
          },
        },
      },
    });
    // Observe the production kernel created by the full startup owner. A bare
    // kernel has not published a live request context and cannot issue authority.
    const createKernel = kernelOwner.createGatewayKernel;
    const capture = vi
      .spyOn(kernelOwner, "createGatewayKernel")
      .mockImplementation(async (...args) => {
        kernel = await createKernel(...args);
        return kernel;
      });
    try {
      server = await startGatewayServerCore(fixture.port, fixture.serverOptions);
    } finally {
      capture.mockRestore();
    }
    const context = expectDefined(kernel, "started kernel").gatewayRequestContext;
    const cfg = context.getRuntimeConfig();
    const tool = createSessionsCreateTool(); // Catalog construction has no caller.
    const keys = () => listSessionEntryKeysReadOnly({ agentId: "main" });
    const initialKeys = await keys();
    expect((await tool.execute("absent", {})).details).toMatchObject({ gated: true });
    expect(await keys()).toEqual(initialKeys);

    const admit = async (scopes: string[]) => {
      const client = createOperatorClient({ profileName: randomUUID(), scopes });
      const source = new AbortController();
      const operator = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client,
          context,
          sourceAuthority: {
            signal: source.signal,
            assertCurrent: () => source.signal.throwIfAborted(),
          },
        }),
        "captured operator authority",
      );
      cleanup.push(() => operator.release());
      const runId = randomUUID();
      const admission = prepareAgentRunAdmission({
        cfg,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        operatorAuthority: operator.authority,
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
        },
      });
      cleanup.push(() => admission.close());
      const admitted = await admission.admit("embedded");
      const participants = createReplyTurnParticipants({ operatorAuthority: operator.authority });
      cleanup.push(() => participants.close());
      const caller = expectDefined(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          requesterOrigin: {
            sessionKey: "agent:main:main",
            operatorProfileId: expectDefined(client.authenticatedUserProfile, "profile").profileId,
          },
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
        "admitted caller",
      );
      return {
        profileId: expectDefined(client.authenticatedUserProfile, "profile").profileId,
        source,
        execute: (callId: string, args: Record<string, unknown>) =>
          withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            () =>
              withGatewayToolCallerIdentity(
                { ...caller, personalToolParticipants: participants },
                () => tool.execute(callId, args),
              ),
          ),
      };
    };

    const reader = await admit(["operator.read"]);
    expect((await reader.execute("read-only", {})).details).toMatchObject({ gated: true });
    expect(await keys()).toEqual(initialKeys);

    const writer = await admit(["operator.sessions.write"]);
    const allowedCwd = path.join(state.workspaceDir, "allowed");
    await fs.mkdir(allowedCwd, { recursive: true });
    const created = await writer.execute("late-authorized", {
      cwd: allowedCwd,
      label: "Late authority persisted",
    });
    expect(created.details).toMatchObject({
      sessionKey: expect.any(String),
      sessionId: expect.any(String),
      runStarted: false,
    });
    const newKeys = (await keys()).filter((key) => !initialKeys.includes(key));
    expect(newKeys).toHaveLength(1);
    const key = expectDefined(newKeys[0], "created session key");
    const persisted = loadSessionEntryReadOnly({ agentId: "main", sessionKey: key });
    expect(persisted).toMatchObject({ label: "Late authority persisted" });
    expect(created.details).toMatchObject({ sessionKey: key, sessionId: persisted?.sessionId });
    const committedKeys = await keys();

    // Prove revalidation after an actual awaited preparation operation, not only
    // denial at entry. Each request reaches cwd validation with live write authority.
    for (const change of ["revoked", "replaced"] as const) {
      const owner = await admit(["operator.sessions.write"]);
      const cwd = path.join(state.workspaceDir, change);
      await fs.mkdir(cwd, { recursive: true });
      const entered = createDeferred();
      const resume = createDeferred();
      const realpath = fs.realpath;
      const io = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        if (args[0] === cwd) {
          entered.resolve();
          await resume.promise;
        }
        return realpath(...args);
      });
      const creation = owner.execute(change, { cwd, label: change });
      // Attach the rejection observer before revoking, so a fast fence is handled.
      const denied = expect(creation).rejects.toThrow(
        change === "revoked"
          ? /source revoked|authority is no longer active/
          : /role changed|access changed|revoked/,
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          creation,
          "creation did not reach filesystem preparation",
        );
        if (change === "revoked") {
          owner.source.abort(new Error("creation source revoked"));
        } else {
          // Replace the current role in the real profile owner, not the retained
          // grant object. The creation owner must reject its now-stale write scope.
          setUserProfileRole(owner.profileId, "authority-reader");
        }
        resume.resolve();
        await denied;
        expect(await keys()).toEqual(committedKeys);
        expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: key })).toEqual(persisted);
      } finally {
        resume.resolve();
        await Promise.allSettled([creation, denied]);
        io.mockRestore();
      }
    }
  } finally {
    for (const dispose of cleanup.toReversed()) {
      dispose();
    }
    if (server) {
      try {
        await server.close();
      } finally {
        await state.cleanup();
      }
    } else {
      await closeKernelFixture(kernel, state);
    }
  }
});
