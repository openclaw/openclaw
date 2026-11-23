import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import {
  removeGatewayTempHome,
  createGatewayConfigPath,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

type Frame = { event?: string; payload?: unknown };
const contains = (frames: Frame[], id: string, phase: string, key: string) =>
  frames.some(
    ({ event, payload }) =>
      event === "session.approval" &&
      isRecord(payload) &&
      payload.phase === phase &&
      payload.sessionKey === key &&
      isRecord(payload.approval) &&
      payload.approval.id === id,
  );

it("delivers configured-store child approvals to the parent session without routing them to unrelated subscribers", async () => {
  const home = await setupGatewayTempHome({ prefix: "openclaw-approval-audience-wire-" });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  const peers: Awaited<ReturnType<typeof connectGatewayClient>>[] = [];
  let phase = "Gateway setup";
  try {
    const token = randomUUID();
    const store = path.join(home.tempHome, "custom-{agentId}", "sessions.json");
    gateway = await startGatewayWithClient({
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: { workspace: home.workspaceDir, skipBootstrap: true },
        },
        session: { store },
        plugins: { slots: { memory: "none" } },
        cron: { enabled: false },
        hooks: { enabled: false },
        gateway: { auth: { mode: "token", token } },
      },
      configPath: await createGatewayConfigPath(home.tempHome),
      token,
      sidecarStartup: "defer",
      clientDisplayName: "audience setup",
    });
    await gateway.server.startupSettled;
    const parent = "agent:main:audience-parent";
    const child = "agent:main:audience-child";
    const unrelated = "agent:main:audience-unrelated";
    for (const key of [parent, unrelated, child]) {
      await expect(
        gateway.client.request("sessions.create", {
          key,
          agentId: "main",
          ...(key === child ? { parentSessionKey: parent } : {}),
        }),
      ).resolves.toMatchObject({ key });
    }
    phase = "real configured-store metadata";
    expect(
      (
        await readSessionEntryReadOnlyInWorker({
          agentId: "main",
          sessionKey: child,
          storePath: resolveSessionStorePathCore(store, { agentId: "main" }),
          hydrateSkillPromptRefs: false,
        })
      )?.parentSessionKey,
    ).toBe(parent);

    // Equal authenticated reviewer authority isolates routing from access-policy differences.
    const url = `ws://127.0.0.1:${gateway.port}`;
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(home.tempHome, "reviewer", "client", "credentials.sqlite"),
    });
    const frames = { parent: [] as Frame[], source: [] as Frame[], unrelated: [] as Frame[] };
    const connect = async (label: keyof typeof frames) => {
      const client = await connectGatewayClient({
        url,
        token,
        deviceIdentity: identity,
        clientDisplayName: `audience ${label}`,
        scopes: ["operator.admin", "operator.approvals"],
        onEvent: (event) => frames[label].push(event),
      });
      peers.push(client);
      return client;
    };
    const parentClient = await connect("parent");
    const sourceClient = await connect("source");
    const unrelatedClient = await connect("unrelated");
    for (const [client, key] of [
      [parentClient, parent],
      [sourceClient, child],
      [unrelatedClient, unrelated],
    ] as const) {
      await expect(
        client.request("sessions.messages.subscribe", {
          key,
          includeApprovals: true,
        }),
      ).resolves.toMatchObject({ subscribed: true });
    }
    const request = (id: string, sessionKey: string) =>
      sourceClient.request("exec.approval.request", {
        id,
        command: "printf audience-fixture",
        agentId: "main",
        sessionKey,
        host: "local",
        ask: "always",
        twoPhase: true,
        requireDeliveryRoute: false,
        timeoutMs: 60_000,
      });
    const resolve = (id: string) =>
      sourceClient.request("exec.approval.resolve", { id, decision: "deny" });
    phase = "unrelated recipient authorization positive";
    await expect(request("audience-control", unrelated)).resolves.toMatchObject({
      status: "accepted",
    });
    await vi.waitFor(() =>
      expect(contains(frames.unrelated, "audience-control", "pending", unrelated)).toBe(true),
    );
    await resolve("audience-control");
    await vi.waitFor(() =>
      expect(contains(frames.unrelated, "audience-control", "terminal", unrelated)).toBe(true),
    );

    phase = "child pending wire";
    const id = "audience-child-approval";
    await expect(request(id, child)).resolves.toMatchObject({ status: "accepted" });
    await vi.waitFor(() => expect(contains(frames.source, id, "pending", child)).toBe(true));
    expect(contains(frames.unrelated, id, "pending", unrelated)).toBe(false);
    console.log(
      "L1 wire setup: configured metadata, paired subscribers, unrelated authorized positive and child pending wire reached",
    );
    phase = "parent replay through real RPC";
    const replay = await parentClient.request("sessions.messages.subscribe", {
      key: parent,
      includeApprovals: true,
    });
    expect(replay).toMatchObject({
      approvalReplay: { approvals: expect.arrayContaining([expect.objectContaining({ id })]) },
    });
    await vi.waitFor(() => expect(contains(frames.parent, id, "pending", parent)).toBe(true));
    await expect(
      unrelatedClient.request("sessions.messages.subscribe", {
        key: unrelated,
        includeApprovals: true,
      }),
    ).resolves.toMatchObject({
      approvalReplay: { approvals: expect.not.arrayContaining([expect.objectContaining({ id })]) },
    });
    phase = "terminal recipient and nonrecipient wire";
    await resolve(id);
    await vi.waitFor(() => expect(contains(frames.source, id, "terminal", child)).toBe(true));
    await vi.waitFor(() => expect(contains(frames.parent, id, "terminal", parent)).toBe(true));
    expect(
      frames.unrelated.some(
        ({ event, payload }) =>
          event === "session.approval" && JSON.stringify(payload).includes(id),
      ),
    ).toBe(false);
    console.log(
      "L1 proof: configured-store creation/read; authenticated parent and child pending/terminal wire; authorized unrelated control; unrelated live/replay exclusion; no command execution",
    );
  } catch (error) {
    console.error(`L1 failed phase: ${phase}`);
    throw error;
  } finally {
    try {
      await Promise.all(peers.map((client) => disconnectGatewayClient(client)));
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "audience wire proof complete" });
        }
      } finally {
        home.envSnapshot.restore();
        await removeGatewayTempHome(home.tempHome);
      }
    }
  }
}, 120_000);
