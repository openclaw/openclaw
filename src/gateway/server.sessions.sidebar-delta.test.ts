import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
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
  openWs,
  onceMessage,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

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
  const controlUi = { allowedOrigins: [origin] };
  testState.gatewayControlUi = controlUi;
  await writeConfigFile({
    gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi },
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
    changedRows: number;
    outcome: "full" | "delta" | "unchanged";
  };
  let observation: Observation | undefined;
  const retirements: string[] = [];
  const stopDiagnostics = onTrustedInternalDiagnosticEvent((entry) => {
    if (entry.type === "sessions.list.baseline.retired") {
      retirements.push(entry.cause);
    }
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
            const response = onceMessage(
              socket,
              (frame) => frame.type === "res" && frame.id === id,
            );
            socket.send(JSON.stringify({ type: "req", id, method, params }));
            const frame = await response;
            expect(frame.ok, JSON.stringify(frame.error)).toBe(true);
            if (method === "sessions.list") {
              observation = {
                changedRows: Array.isArray(frame.payload?.sessions)
                  ? frame.payload.sessions.length
                  : 0,
                outcome: frame.payload?.rowsUnchanged
                  ? "unchanged"
                  : frame.payload?.rowsDelta
                    ? "delta"
                    : "full",
              };
            }
            return frame.payload as T;
          },
        };
        const snapshot = {
          client: null,
          phase: "connected" as const,
          hello: null,
          selfUser: { id: viewer.id },
        };
        const queries = [false, true].map((involvingMe) => {
          const options = sidebarSessionListQuery(
            {
              sidebarSessionOwnerFilter: () => ({ ownerId: "", involvingMe }),
              sidebarSessionStatusFilter: () => "active",
            },
            "main",
          );
          return {
            name: involvingMe ? "involving" : "general",
            params: buildSessionListParams(prepareSessionRefreshOptions(options, snapshot)),
          };
        });
        const read = async (
          label: string,
          expected: Observation["outcome"],
          expectedRow?: object,
        ) => {
          for (const entry of queries) {
            const result = await requestSessionListParams(client, entry.params, () => true);
            expect(result?.sessions).toHaveLength(entry.name === "general" ? 16 : 8);
            const row = result?.sessions.find((candidate) => candidate.key === target.sessionKey);
            if (expectedRow) {
              expect(row).toMatchObject(expectedRow);
            }
            if (label === "activity-expiry") {
              expect(row?.agentStatus).toBeUndefined();
            }
            expect.soft(observation, `${label}/${entry.name}`).toMatchObject({
              outcome: expected,
              ...(expected === "delta" ? { changedRows: 1 } : {}),
            });
          }
        };
        await read("initial", "full");
        await read("idle", "unchanged");
        await client.request("sessions.patch", {
          key: target.sessionKey,
          label: "Renamed sidebar",
        });
        await read("label", "delta", { label: "Renamed sidebar" });
        registerAgentRunContext(runIds[0]!, {
          ...target,
          sessionId: "sidebar-session-0",
          projectSessionActive: true,
        });
        const running = { hasActiveRun: true, status: "running" };
        const done = { hasActiveRun: false, status: "done" };
        await read("keyed-run-start", "delta", running);
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
        await read("activity-and-usage", "delta", { agentStatus: { note: "Reading the source" } });
        now += 61_000;
        await read("activity-expiry", "delta");
        clearAgentRunContext(runIds[0]!);
        await patchSessionEntryCore(target, () => ({ status: "done" }));
        await read("keyed-run-end", "delta", done);
        // Session-id-only runs are a real registry contract and publish broad runtime changes.
        registerAgentRunContext(runIds[1]!, {
          agentId: "main",
          sessionId: "sidebar-session-0",
          projectSessionActive: true,
        });
        await read("session-id-run-start", "delta", running);
        clearAgentRunContext(runIds[1]!);
        await read("session-id-run-end", "delta", done);
        for (const [action, label] of [
          ["add", "added"],
          ["remove", "removed"],
        ]) {
          await client.request(`session.members.${action}`, {
            sessionKey: target.sessionKey,
            identityId: peer.id,
          });
          await read(`member-${label}`, "delta");
        }
        await waitForDiagnosticEventsDrained();
        expect.soft(retirements).toEqual([]);
        await client.request("users.setDisplayName", {
          profileId: viewer.id,
          displayName: "Updated sidebar reader",
        });
        await read("profile-presentation", "full", {
          createdActor: { label: "Updated sidebar reader" },
        });
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
    clock.mockRestore();
  }
});
