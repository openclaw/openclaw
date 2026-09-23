import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNativeUIApprovalReleased,
  createInstalledNativeUIMatrix,
  settleNativeUIApproval,
  type Approval,
} from "../../scripts/lib/installed-native-ui-matrix.mts";
import type {
  ProfileWireFixture,
  ProfileWireProvider,
} from "../e2e/qa-lab/runtime/profile-binding-wire-fixture.js";
import type { startQaGatewayRpcProxy } from "../fixtures/qa-gateway-rpc-proxy.mjs";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

type Fixture = ProfileWireFixture<ProfileWireProvider>;
type Proxy = Awaited<ReturnType<typeof startQaGatewayRpcProxy>>;
const pending = (): Approval => ({
  sessionKey: "agent:qa:approval",
  runID: "run-one",
  id: "approval-one",
  hash: "proposal-one",
  requestID: "request-one",
  joined: false,
});
const terminal = {
  id: "approval-one",
  status: "denied",
  decision: "deny",
  reason: "user",
  presentation: { kind: "system-agent", proposalHash: "proposal-one" },
  source: { agentId: "qa", sessionKey: "agent:qa:approval" },
};

describe("installed native UI producer custody", () => {
  it("preserves the original readback failure while cleanup joins an already committed denial", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "native-ui-settlement-"));
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ logging: { level: "debug" } }));
    const approval = pending();
    const failure = new Error("terminal readback failed after the winning decision");
    let decisions = 0;
    let readbacks = 0;
    let joins = 0;
    const fixture = {
      instance: { configPath },
      admin: {
        async request(method: string, params: Record<string, unknown>) {
          if (method === "approval.resolve") {
            decisions += 1;
            assert.deepEqual(params, { id: approval.id, kind: "system-agent", decision: "deny" });
            return { applied: decisions === 1, approval: terminal };
          }
          if (method === "approval.get") {
            if (++readbacks === 1) {
              throw failure;
            }
            return { approval: terminal };
          }
          if (method === "openclaw.approval.list") {
            return [];
          }
          if (method === "agent.wait") {
            joins += 1;
            assert.equal(params.runId, approval.runID);
            return { status: "ok" };
          }
          if (method === "chat.history") {
            return {
              messages: [
                {
                  role: "toolResult",
                  toolName: "openclaw",
                  content: [
                    { type: "text", text: JSON.stringify({ reply: "Denied. No change." }) },
                  ],
                },
              ],
            };
          }
          throw new Error("Unexpected settlement request: " + method);
        },
      },
    } as unknown as Fixture;
    try {
      await expect(
        runQaGatewayFixture(
          () => settleNativeUIApproval(approval, fixture, async () => {}),
          () => settleNativeUIApproval(approval, fixture, async () => {}),
        ),
      ).rejects.toBe(failure);
      expect({ decisions, readbacks, joins }).toEqual({ decisions: 1, readbacks: 2, joins: 1 });
      expect(approval).toMatchObject({ decisionTaken: true, joined: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["invalid", "undelivered", "foreign-request", "foreign-event"])(
    "rejects %s after the exact approval producer was initially bound",
    (fault) => {
      const approval = pending();
      const snapshot = {
        approval: {
          status: "released",
          connection: 7,
          expectedProfileId: "alice",
          sessionKey: approval.sessionKey,
          agentId: "qa",
          approvalId: approval.id,
          runId: approval.runID,
          proposalHash: approval.hash,
          requestId: approval.requestID,
        },
        events: [
          {
            kind: "response-released",
            connection: 7,
            requestId: approval.requestID,
            delivered: true,
          },
        ],
      };
      assertNativeUIApprovalReleased(
        approval,
        snapshot as unknown as ReturnType<Proxy["snapshot"]>,
        7,
        "alice",
      );
      if (fault === "invalid") {
        snapshot.approval.status = "invalid";
      }
      if (fault === "undelivered") {
        snapshot.events[0]!.delivered = false;
      }
      if (fault === "foreign-request") {
        snapshot.approval.requestId = "request-two";
      }
      if (fault === "foreign-event") {
        snapshot.approval.proposalHash = "proposal-two";
      }
      expect(() =>
        assertNativeUIApprovalReleased(
          approval,
          snapshot as unknown as ReturnType<Proxy["snapshot"]>,
          7,
          "alice",
        ),
      ).toThrow();
    },
  );

  it("closes an unfinished incoming body before joining the control task", async () => {
    const messages = new Map<string, Array<Record<string, unknown>>>();
    let runs = 0;
    const request = async (method: string, params: Record<string, unknown>) => {
      if (method === "sessions.create") {
        messages.set(String(params.key), []);
        return { key: params.key };
      }
      if (method === "sessions.patch") {
        return {};
      }
      if (method === "sessions.describe") {
        return {
          session: {
            key: params.key,
            agentRuntime: { id: "openclaw" },
            ...(String(params.key).includes("dashboard") ? { boardFace: "dashboard" } : {}),
          },
        };
      }
      if (method === "chat.send") {
        const rows = messages.get(String(params.sessionKey))!;
        rows.push({
          role: "user",
          __openclaw: { id: "entry-" + rows.length },
          content: [{ type: "text", text: params.message }],
        });
        return { runId: "seed-" + ++runs };
      }
      if (method === "agent.wait") {
        return { status: "ok" };
      }
      if (method === "chat.history") {
        return {
          messages: [
            ...messages.get(String(params.sessionKey))!,
            ...(String(params.sessionKey).includes("other")
              ? [{ role: "assistant", content: [{ type: "text", text: "Seed reply" }] }]
              : []),
          ],
        };
      }
      throw new Error("Unexpected fixture request: " + method);
    };
    const fixture = {
      alice: { request },
      admin: { request },
      instance: { state: { workspaceDir: "/fixture/workspace" } },
    } as unknown as Fixture;
    const proxy = { snapshot: () => ({ heldResponse: null }) } as unknown as Proxy;
    const matrix = await createInstalledNativeUIMatrix(
      fixture,
      proxy,
      "fixture-token",
      "unused",
      "tablet",
      "held-body",
    );
    const endpoint = new URL(matrix.controlURL);
    const socket = net.connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    socket.on("error", () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const admitted = new Promise<void>((resolve, reject) => {
        let response = "";
        const onData = (bytes: Buffer) => {
          response += bytes.toString();
          if (response.includes("HTTP/1.1 100 Continue\r\n\r\n")) {
            socket.off("data", onData);
            resolve();
          }
        };
        socket.on("data", onData);
        socket.once("error", reject);
      });
      socket.write(
        "POST " +
          endpoint.pathname +
          " HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
          "Expect: 100-continue\r\nContent-Length: 999\r\n\r\n",
      );
      await admitted;
      const released = matrix.releaseGates();
      expect(matrix.releaseGates()).toBe(released);
      await released;
      const stopped = matrix.stop();
      expect(matrix.stop()).toBe(stopped);
      await stopped;
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      await closed;
      await matrix.releaseGates();
      await matrix.stop();
    }
  });
});
