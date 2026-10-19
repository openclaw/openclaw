import { randomUUID } from "node:crypto";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, test, vi } from "vitest";
import { SESSION_ROWS_DELTA_PREFIX } from "../../packages/gateway-protocol/src/session-row-fields.js";
import { sidebarSessionListQuery } from "../../ui/src/components/session-data-events.js";
import type { SessionRequestClient } from "../../ui/src/lib/sessions/session-capability.js";
import { prepareSessionRefreshOptions } from "../../ui/src/lib/sessions/session-list-query.js";
import {
  buildSessionListParams,
  requestSessionListParams,
} from "../../ui/src/lib/sessions/session-requests.js";
import { writeConfigFile } from "../config/config.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { emitAgentEvent, emitAgentRunOutputTokens } from "../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  onceMessage,
  openWs,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import * as presentation from "./session-row-presentation.js";

installGatewayTestHooks({ scope: "suite" });

test("sidebar wire caches retain deltas across real runtime publications", async () => {
  const origin = "https://sidebar.example.test";
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [origin] },
    },
  });
  const viewer = ensureProfileForEmail("sidebar-reader@example.test");
  const peer = ensureProfileForEmail("sidebar-peer@example.test");
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const target = { agentId: "main", sessionKey: "agent:main:sidebar-0" };
  for (let index = 0; index < 16; index++) {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: `agent:main:sidebar-${index}` },
      {
        sessionId: `sidebar-session-${index}`,
        label: `Sidebar session ${index}`,
        updatedAt: now - index,
        lastActivityAt: now - index,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: index < 8 ? viewer.id : peer.id },
      },
    );
  }
  type Observation = {
    event: string;
    query: string;
    baseSent: boolean;
    baseFound: boolean;
    changedRows: number;
    outcome: "full" | "delta" | "unchanged";
    bytes?: number;
  };
  const observations: Observation[] = [];
  const retirements: string[] = [];
  const stopDiagnostics = onTrustedInternalDiagnosticEvent((entry) => {
    if (entry.type === "sessions.list.baseline.retired") {
      retirements.push(entry.cause);
    }
  });
  let event = "initial";
  let query = "general";
  const share = presentation.shareSidebarSessionRows;
  const servedRows = new Map<string, Parameters<typeof share>[0]>();
  const shareObserver = vi
    .spyOn(presentation, "shareSidebarSessionRows")
    .mockImplementation((rows, base, history) => {
      const revision = base?.replace(SESSION_ROWS_DELTA_PREFIX, "");
      const found = revision
        ? share(rows).rowsRevision === revision ||
          history?.some((candidate) => candidate.revision === revision) === true
        : false;
      const previous = revision ? servedRows.get(revision) : undefined;
      const result = share(rows, base, history);
      if (result.rowsRevision) {
        servedRows.set(result.rowsRevision, rows);
      }
      observations.push({
        event,
        query,
        baseSent: base !== undefined,
        baseFound: found,
        changedRows: previous ? rows.filter((row) => !previous.includes(row)).length : rows.length,
        outcome: result.rowsUnchanged ? "unchanged" : result.rowsDelta ? "delta" : "full",
      });
      return result;
    });
  try {
    await withGatewayServer(async ({ port }) => {
      const socket = await openWs(port, {
        origin,
        "x-forwarded-for": "203.0.113.51",
        "x-forwarded-proto": "https",
        "x-forwarded-user": "sidebar-reader@example.test",
      });
      const runIds = ["sidebar-keyed-run", "sidebar-session-id-run"];
      try {
        const connected = await connectReq(socket, {
          skipDefaultAuth: true,
          client: CONTROL_UI_CLIENT,
          prePairDevice: true,
          scopes: ["operator.read", "operator.write", "operator.admin"],
          browserOrigin: origin,
        });
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        const client: SessionRequestClient = {
          async request<T>(method: string, params?: unknown): Promise<T> {
            const id = randomUUID();
            let bytes = 0;
            const capture = (data: Parameters<typeof rawDataToString>[0]) => {
              const text = rawDataToString(data);
              const frame = JSON.parse(text) as { id?: string };
              if (frame.id === id) {
                bytes = Buffer.byteLength(text);
              }
            };
            socket.on("message", capture);
            try {
              const response = onceMessage(
                socket,
                (frame) => frame.type === "res" && frame.id === id,
              );
              socket.send(JSON.stringify({ type: "req", id, method, params }));
              const frame = await response;
              expect(frame.ok, JSON.stringify(frame.error)).toBe(true);
              if (method === "sessions.list") {
                const observed = observations.at(-1)!;
                observed.bytes = bytes;
                observed.outcome = frame.payload?.rowsUnchanged
                  ? "unchanged"
                  : frame.payload?.rowsDelta
                    ? "delta"
                    : "full";
              }
              // The real transport decodes JSON; each caller owns its result contract.
              return frame.payload as T;
            } finally {
              socket.off("message", capture);
            }
          },
        };
        const snapshot = {
          client: null,
          phase: "connected" as const,
          offlineStable: false,
          hello: null,
          canvasPluginSurfaceUrl: null,
          assistantAgentId: "main",
          sessionKey: target.sessionKey,
          lastError: null,
          lastErrorCode: null,
          selfUser: { id: viewer.id },
        };
        const queries = [false, true].map((involvingMe) => ({
          name: involvingMe ? "involving" : "general",
          params: buildSessionListParams(
            prepareSessionRefreshOptions(
              sidebarSessionListQuery(
                {
                  sidebarSessionOwnerFilter: () => ({ ownerId: "", involvingMe }),
                  sidebarSessionStatusFilter: () => "active",
                },
                "main",
              ),
              snapshot,
            ),
          ),
        }));
        const read = async (label: string, expected: Observation["outcome"]) => {
          event = label;
          for (const entry of queries) {
            query = entry.name;
            const result = await requestSessionListParams(client, entry.params, () => true);
            expect(result?.sessions).toHaveLength(entry.name === "general" ? 16 : 8);
            if (label === "activity-and-usage") {
              expect(
                result?.sessions.find((row) => row.key === target.sessionKey)?.agentStatus?.note,
              ).toBe("Reading the source");
            } else if (label === "activity-expiry") {
              expect(
                result?.sessions.find((row) => row.key === target.sessionKey)?.agentStatus,
              ).toBeUndefined();
            } else if (label === "profile-presentation") {
              expect(
                result?.sessions.find((row) => row.key === target.sessionKey)?.createdActor?.label,
              ).toBe("Updated sidebar reader");
            }
            const row = result?.sessions.find((candidate) => candidate.key === target.sessionKey);
            if (label.endsWith("run-start")) {
              expect(row?.hasActiveRun).toBe(true);
              expect(row?.status).toBe("running");
            } else if (label.endsWith("run-end")) {
              expect(row?.hasActiveRun).toBe(false);
              expect(row?.status).toBe("done");
            } else if (label === "label") {
              expect(row?.label).toBe("Renamed sidebar");
            }
            expect.soft(observations.at(-1)?.outcome, `${label}/${query}`).toBe(expected);
            if (expected === "delta") {
              expect
                .soft(observations.at(-1), `${label}/${query} base and row reuse`)
                .toMatchObject({
                  baseSent: true,
                  baseFound: true,
                  changedRows: 1,
                });
            }
            console.log("SIDEBAR_DELTA_WIRE", JSON.stringify(observations.at(-1)));
          }
        };
        await read("initial", "full");
        await read("idle", "unchanged");
        await client.request("sessions.patch", {
          key: target.sessionKey,
          label: "Renamed sidebar",
        });
        await read("label", "delta");
        registerAgentRunContext(runIds[0]!, {
          ...target,
          sessionId: "sidebar-session-0",
          projectSessionActive: true,
        });
        await read("keyed-run-start", "delta");
        emitAgentEvent({
          runId: runIds[0]!,
          ...target,
          stream: "tool",
          data: { phase: "start", toolCallId: "sidebar-tool", name: "read" },
        });
        emitAgentRunOutputTokens({
          runId: runIds[0]!,
          lifecycleGeneration: getAgentRunLifecycleGeneration(),
          outputTokens: 42,
          sessionKey: target.sessionKey,
        });
        await patchSessionEntryCore(target, () => ({
          totalTokens: 42,
          lastActivityAt: ++now,
          agentStatus: { note: "Reading the source", expiresAt: now + 60_000 },
        }));
        await read("activity-and-usage", "delta");
        now += 61_000;
        await read("activity-expiry", "delta");
        clearAgentRunContext(runIds[0]!);
        await patchSessionEntryCore(target, () => ({ status: "done" }));
        await read("keyed-run-end", "delta");
        // Session-id-only runs are a real registry contract and publish broad runtime changes.
        registerAgentRunContext(runIds[1]!, {
          agentId: "main",
          sessionId: "sidebar-session-0",
          projectSessionActive: true,
        });
        await read("session-id-run-start", "delta");
        clearAgentRunContext(runIds[1]!);
        await read("session-id-run-end", "delta");
        await client.request("session.members.add", {
          sessionKey: target.sessionKey,
          identityId: peer.id,
        });
        await read("member-added", "delta");
        await client.request("session.members.remove", {
          sessionKey: target.sessionKey,
          identityId: peer.id,
        });
        await read("member-removed", "delta");
        await waitForDiagnosticEventsDrained();
        expect.soft(retirements).toEqual([]);
        await client.request("users.setDisplayName", {
          profileId: viewer.id,
          displayName: "Updated sidebar reader",
        });
        await read("profile-presentation", "full");
        await waitForDiagnosticEventsDrained();
        expect.soft(retirements).toEqual(["identity"]);
        await read("profile-idle", "unchanged");
        setRuntimeConfigSnapshot({
          ...getRuntimeConfigSnapshot(),
          ui: { prefs: { sidebarEntries: ["sessions"] } },
        });
        await read("config-presentation", "full");
        await waitForDiagnosticEventsDrained();
        expect.soft(retirements).toEqual(["identity", "config"]);
      } finally {
        runIds.forEach((runId) => clearAgentRunContext(runId));
        socket.close();
      }
    });
  } finally {
    stopDiagnostics();
    shareObserver.mockRestore();
    clock.mockRestore();
  }
});
