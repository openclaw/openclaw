/** Targeted system-event routing and wake behavior. */

import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG,
  SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS,
} from "../../../packages/gateway-protocol/src/schema.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  requestHeartbeat: vi.fn(),
  loadGatewaySessionEntryReadOnly: vi.fn(),
}));

vi.mock("../../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/heartbeat-wake.js")>()),
  requestHeartbeat: mocks.requestHeartbeat,
}));

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnlyAsync: mocks.loadGatewaySessionEntryReadOnly,
}));

vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
    mocks.loadGatewaySessionEntryReadOnly(params.key, { agentId: params.agentId }),
}));

import { systemHandlers } from "./system.js";

const eventHandler = expectDefined(systemHandlers["system-event"], "system-event handler");
const eventText = "OpenClaw updated. Welcome the user back.";
function eventRequest(
  params: GatewayRequestHandlerOptions["params"],
  respond = vi.fn(),
  config: OpenClawConfig = { agents: { entries: { main: {} } } },
): GatewayRequestHandlerOptions {
  return {
    params,
    respond,
    context: { publishPresence: vi.fn(), getRuntimeConfig: () => config },
  } as unknown as GatewayRequestHandlerOptions;
}

async function sendEvent(params: GatewayRequestHandlerOptions["params"], config?: OpenClawConfig) {
  const respond = vi.fn();
  await eventHandler(eventRequest(params, respond, config));
  return respond;
}

describe("system-event routing", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  afterEach(() => {
    resetSystemEventsForTest();
    mocks.requestHeartbeat.mockReset();
    mocks.loadGatewaySessionEntryReadOnly.mockReset();
  });

  it("queues and immediately wakes the requested session", async () => {
    const sessionKey = "agent:main:main";
    mocks.loadGatewaySessionEntryReadOnly.mockReturnValue({ entry: { sessionId: "session" } });
    const respond = await sendEvent({ text: eventText, sessionKey, wake: true });

    expect(peekSystemEvents(sessionKey)).toEqual([eventText]);
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey,
      heartbeat: { target: "last" },
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("wakes an unbound memory session and observes its next committed archive", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/system-event-memory" };
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const sessionKey = "agent:main:dashboard:incognito-wake";
    const authority = { assertCurrent() {}, authorize() {} };
    const binding = await acquireSessionActorStorage(
      {
        agentId: "main",
        sessionKey,
        env,
        storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      },
      { authority, lifetime: { assertCurrent() {}, assertReadable() {} }, create: true },
    );
    if (!binding) {
      throw new Error("Memory session fixture was not acquired");
    }
    try {
      expect(
        await binding.actor.storage.mutate(
          {
            type: "session.entry.create",
            input: {
              entry: { sessionId: "memory-wake", updatedAt: 1, incognito: true },
            },
          },
          authority,
        ),
      ).toMatchObject({ kind: "committed" });
      const respond = vi.fn();
      const request = eventRequest(
        { text: "Synthetic memory wake", sessionKey, wake: true },
        respond,
      );
      await eventHandler(request);
      expect(respond).toHaveBeenLastCalledWith(true, { ok: true }, undefined);
      expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
      expect(mocks.loadGatewaySessionEntryReadOnly).not.toHaveBeenCalled();
      expect(
        await binding.actor.storage.mutate(
          {
            type: "session.entry.patch",
            input: {
              operation: { kind: "fields", patch: { archivedAt: 2 } },
            },
          },
          authority,
        ),
      ).toMatchObject({ kind: "committed" });
      await eventHandler(request);
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: `Unknown or archived session "${sessionKey}"`,
        }),
      );
      expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
    } finally {
      await binding.actor.release();
      memorySessionActorOwners.reset();
      vi.unstubAllEnvs();
    }
  });
  it("keeps ambient explicit-owner events on the global session queue", async () => {
    const respond = await sendEvent(
      { text: "Wake the system owner.", wake: true },
      {
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, molty: {} },
        },
      },
    );

    expect(peekSystemEvents("agent:main:global")).toEqual(["Wake the system owner."]);
    expect(peekSystemEvents("agent:main:main")).toEqual([]);
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      agentId: "main",
      sessionKey: "global",
      heartbeat: { target: "last" },
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it.each(["unknown-agent", "missing", "archived-zero", "archived", "node"] as const)(
    "rejects immediate wake for %s without queueing or starting work",
    async (kind) => {
      const sessionKey = kind === "unknown-agent" ? "agent:bogus:main" : "agent:main:missing";
      if (kind !== "unknown-agent" && kind !== "node") {
        mocks.loadGatewaySessionEntryReadOnly.mockReturnValue({
          entry:
            kind === "missing"
              ? undefined
              : {
                  sessionId: "archived-session",
                  archivedAt: kind === "archived-zero" ? 0 : 1,
                },
        });
      }
      const respond = await sendEvent({
        text: kind === "node" ? "Node: Operator Mac" : eventText,
        sessionKey,
        wake: true,
        ...(kind === "node" ? { deviceId: "device-1" } : {}),
      });
      expect(peekSystemEvents(sessionKey)).toEqual([]);
      expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message:
            kind === "unknown-agent"
              ? 'Unknown agent id "bogus"'
              : kind === "node"
                ? "wake is not supported for node presence events"
                : `Unknown or archived session "${sessionKey}"`,
        }),
      );
      if (kind === "node") {
        expect(mocks.loadGatewaySessionEntryReadOnly).not.toHaveBeenCalled();
      }
    },
  );

  it("passes explicit input activity clearing into system presence", async () => {
    const instanceId = `presence-clear-${randomUUID()}`;

    await sendEvent({
      text: "Node: Operator Mac",
      instanceId,
      host: "Operator Mac",
      mode: "ui",
      lastInputSeconds: 5,
    });
    await sendEvent({
      text: "Node: Operator Mac",
      instanceId,
      host: "Operator Mac",
      mode: "ui",
      lastInputSeconds: SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS,
      tags: [SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG],
    });

    const entry = listSystemPresence().find((candidate) => candidate.instanceId === instanceId);
    expect(entry?.lastInputSeconds).toBeUndefined();
  });

  it.each([
    { kind: "macOS beacon", clientId: "openclaw-macos", text: "Node: Operator Mac", own: true },
    {
      kind: "explicit device",
      clientId: "openclaw-macos",
      text: "Node: Other Mac",
      explicit: true,
    },
    { kind: "ordinary event", clientId: "openclaw-macos", text: "Update complete" },
    { kind: "other client", clientId: "cli", text: "Node: Other Mac" },
    {
      kind: "device-less client",
      clientId: "openclaw-macos",
      text: "Node: Operator Mac",
      noDevice: true,
    },
  ] as const)("preserves the intended presence identity for $kind", async (scenario) => {
    const instanceId = `presence-device-${randomUUID()}`;
    const deviceId = `device-${randomUUID()}`;
    const explicitDeviceId = "explicit" in scenario ? `remote-${randomUUID()}` : undefined;
    const request = eventRequest({ text: scenario.text, instanceId, deviceId: explicitDeviceId });
    request.client = {
      connect: {
        client: { id: scenario.clientId },
        ...("noDevice" in scenario ? {} : { device: { id: deviceId } }),
      },
    } as NonNullable<GatewayRequestHandlerOptions["client"]>;
    await eventHandler(request);

    const entry = expectDefined(
      listSystemPresence().find((candidate) => candidate.instanceId === instanceId),
      "system-event presence entry",
    );
    expect(entry.deviceId).toBe(explicitDeviceId ?? ("own" in scenario ? deviceId : undefined));
  });
});
