import http, { createServer, type IncomingMessage } from "node:http";
import { expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  formatIrohEndpointKey,
  generateEd25519Signer,
  signStatement,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import { getRuntimeConfig } from "../config/config.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { linkCanonicalOpenClawIdUserProfile } from "../state/user-profile-openclaw-id.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { sendChatAndWait } from "./gateway-chat-fixture.test-support.js";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { readStoredClaw, writeStoredClaw } from "./openclaw-id/claw-store.js";
import { MEMBER_ROLE_PRESETS } from "./openclaw-id/member-role-presets.test-support.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import { setOpenClawIdOwnerAccountResolver } from "./openclaw-id/owner-account.js";
import { startGatewayServerCore } from "./server-start.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
type CutOff =
  | "control"
  | "admin-sets-null"
  | "owner-sets-reader"
  | "owner-sets-null"
  | "openclaw-id-remove";
type Hold = { marker: string; aborted: boolean; release: () => void };

const ROLES: Record<string, GatewayOperatorRoleDefinition> = {
  // Admission assigns this role before the first connection.
  "member-label": {
    sessions: { others: "none" },
    agents: "*",
    scopes: ["operator.read", "operator.write"],
  },
  worker: {
    sessions: { others: "none" },
    agents: "*",
    scopes: ["operator.read", "operator.write", "operator.approvals"],
  },
  reader: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
  administrator: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
};

async function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function until(check: () => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(100);
  }
  return true;
}

async function runScenario(cutOff: CutOff, signal: AbortSignal) {
  const state = await createOpenClawTestState({
    ...kernelGatewayTestStateOptions(`oid-suspend-${cutOff}`),
    env: {
      ...kernelGatewayTestStateOptions(`oid-suspend-${cutOff}`).env,
      OPENCLAW_SKIP_CRON: undefined,
    },
  });
  const clients: Client[] = [];
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  const seen: Array<{ marker: string; at: number }> = [];
  const holds = new Map<string, Hold>();
  const mark = (marker: string) => seen.push({ marker, at: Date.now() });
  const provider = createServer((request, response) => {
    void readRequestText(request).then((body) => {
      if (body.includes("Generate a concise session title")) {
        writeOpenAiResponsesText(response, { text: "Title", messageId: "t", responseId: "t" });
        return;
      }
      const input = (JSON.parse(body) as { input?: Array<{ type?: string }> }).input ?? [];
      const lastOutput = input.findLastIndex((item) => item.type === "function_call_output");
      const pending = JSON.stringify(input.slice(lastOutput + 1));
      const reply = () =>
        writeOpenAiResponsesText(response, { text: "Done.", messageId: "r", responseId: "r" });
      for (const marker of ["QUEUED_FOLLOWUP", "STEERED_INPUT", "CRON_RUN_MARKER"]) {
        if (pending.includes(marker)) {
          mark(marker);
        }
      }
      const holdMarker = ["CHILD_HOLD", "HOLD_TURN"].find((marker) => pending.includes(marker));
      if (holdMarker && !holds.has(holdMarker)) {
        mark(holdMarker);
        const hold: Hold = {
          marker: holdMarker,
          aborted: false,
          release: () => {
            if (!hold.aborted && !response.writableEnded) {
              reply();
            }
          },
        };
        response.on("close", () => {
          if (!response.writableEnded) {
            hold.aborted = true;
          }
        });
        holds.set(holdMarker, hold);
        return;
      }
      if (pending.includes("PLEASE_SPAWN")) {
        // Deferred tools are reached through dispatch_action.
        writeToolCall(response, "dispatch_action", {
          id: "sessions_spawn",
          args: { task: "CHILD_HOLD investigate" },
        });
        return;
      }
      if (pending.includes("MAKE_CRON")) {
        writeToolCall(response, "dispatch_action", {
          id: AUTOMATIONS_TOOL_NAME,
          args: { action: "plan", names: ["Member job"] },
        });
        return;
      }
      if (JSON.stringify(input[lastOutput])?.includes("automation_creation_plan")) {
        writeToolCall(response, "dispatch_action", {
          id: AUTOMATIONS_TOOL_NAME,
          args: {
            action: "add",
            job: {
              name: "Member job",
              schedule: { kind: "every", everyMs: 3_600_000 },
              sessionTarget: "isolated",
              payload: { kind: "agentTurn", message: "CRON_RUN_MARKER report" },
              delivery: { mode: "none" },
            },
          },
        });
        return;
      }
      reply();
    });
  });
  const model = buildMockOpenAiResponsesProvider(await listenProvider(provider), "oid-suspend");
  const port = await getFreePort();
  const token = "oid-suspend-token";
  const people = {
    member: { origin: "http://member.test", account: "acct-member" },
    admin: { origin: "http://admin.test", account: "acct-admin" },
  } as const;
  const ownerDeviceOrigin = "http://owner-device.test";
  const peers = new Map<string, ReturnType<typeof formatIrohEndpointKey>>();
  for (const person of Object.values(people)) {
    peers.set(person.origin, formatIrohEndpointKey((await generateEd25519Signer()).publicKey));
  }
  // oxlint-disable-next-line typescript/unbound-method -- The observer supplies the original server receiver.
  const emit = http.Server.prototype.emit;
  const intercepted = vi.spyOn(http.Server.prototype, "emit").mockImplementation(function (
    this: http.Server,
    event,
    ...args
  ) {
    if (event === "upgrade" || event === "request") {
      const req = args[0] as IncomingMessage;
      const peerKey = req.headers.origin ? peers.get(req.headers.origin) : undefined;
      if (peerKey) {
        markGatewayIngressTransport(req, {
          kind: "openclaw-id-tunnel",
          peerKey,
          clientIp: "fd7a:115c:a1e0::1",
        });
      }
    }
    return emit.call(this, event, ...args);
  });
  try {
    await state.writeConfig({
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: model.modelRef },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
        },
      },
      plugins: { slots: { memory: "none" } },
      tools: { profile: "full" },
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token },
        openclawId: { enabled: true },
        roles: { definitions: ROLES },
        controlUi: {
          allowedOrigins: [
            `http://127.0.0.1:${port}`,
            ownerDeviceOrigin,
            ...Object.values(people).map((p) => p.origin),
          ],
        },
      },
    });
    const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
    peers.set(ownerDeviceOrigin, claw.w1);
    for (const person of Object.values(people)) {
      expect(
        await claw.authority.submit(
          await claw.sign({
            op: "add",
            account_id: person.account,
            role: "member-label",
            peer_keys: [peers.get(person.origin)!],
            invite_id: null,
          }),
          "tunnel",
        ),
      ).toMatchObject({ ok: true });
    }
    await claw.authority.bindToken("seed", "operator", peers.get(people.member.origin)!);
    server = await startGatewayServerCore(port, { bind: "loopback", controlUiEnabled: false });
    await expect
      .poll(() => getRuntimeConfig().gateway?.roles?.definitions.operator)
      .toEqual(MEMBER_ROLE_PRESETS.operator);
    const owner = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      origin: `http://127.0.0.1:${port}`,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      platform: "web",
      scopes: ["operator.admin"],
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      signal,
    });
    clients.push(owner);

    const connect = async (origin: string) => {
      let closeCode: number | undefined;
      let scopes: string[] | undefined;
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        origin,
        timeoutMs: 6000,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        platform: "web",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
        onHelloOk: (hello) => {
          scopes = hello.auth?.scopes;
        },
        onClose: (code) => {
          closeCode ??= code;
        },
        signal,
      });
      clients.push(client);
      const self = await settle(client.request<{ profile: { id: string } }>("users.self", {}));
      return {
        client,
        scopes,
        profileId: self.ok ? self.value.profile.id : undefined,
        closeCode: () => closeCode,
      };
    };
    // First connection creates each linked profile under the membership label.
    const firstMember = await connect(people.member.origin);
    const firstAdmin = await connect(people.admin.origin);
    const memberProfile = firstMember.profileId!;
    const adminProfile = firstAdmin.profileId!;
    await owner.request("users.setRole", { profileId: memberProfile, role: "worker" });
    await owner.request("users.setRole", { profileId: adminProfile, role: "administrator" });
    const report: Record<string, unknown> = { cutOff };
    report.setupFirstConnectionClosedByOwnerSetRole = await until(
      () => firstMember.closeCode() !== undefined,
      5000,
    );
    const member = await connect(people.member.origin);
    const admin = await connect(people.admin.origin);
    report.profileRoleApplies = {
      member: member.scopes?.toSorted(),
      admin: admin.scopes?.toSorted(),
      memberProfileId: member.profileId === memberProfile,
    };

    const send = (client: Client, sessionKey: string, message: string, extra = {}) =>
      settle(
        client.request("chat.send", {
          sessionKey,
          message,
          idempotencyKey: `${message}-${cutOff}`,
          ...extra,
        }),
      ).then((result) => (result.ok ? "accepted" : result.error));
    const create = async () =>
      (await member.client.request<{ key: string }>("sessions.create", { agentId: "main" })).key;

    // Work the member owns before the cut-off.
    const cronSession = await create();
    report.cronCreateTurn = await sendChatAndWait(
      member.client,
      cronSession,
      "MAKE_CRON now",
      120_000,
    );
    const jobs = async () =>
      (
        await owner.request<{
          jobs: Array<{ id: string; enabled?: boolean; createdBy?: unknown }>;
        }>("cron.list", { includeDisabled: true })
      ).jobs;
    const job = (await jobs())[0];
    report.cronJobCreated = Boolean(job);
    const s1 = await create();
    report.holdTurn = await send(member.client, s1, "HOLD_TURN please");
    report.holdStarted = await until(() => holds.has("HOLD_TURN"));
    report.queuedFollowup = await send(member.client, s1, "QUEUED_FOLLOWUP later", {
      queueMode: "followup",
    });
    report.steeredInput = await send(member.client, s1, "STEERED_INPUT now", {
      queueMode: "steer",
    });
    const s2 = await create();
    report.spawnTurn = await send(member.client, s2, "PLEASE_SPAWN a helper");
    report.childStarted = await until(() => holds.has("CHILD_HOLD"));

    // An owner device linked to a person profile; role-only changes must leave it alone.
    const person = await ensureCanonicalUserProfileForEmail("owner-person@example.test");
    setOpenClawIdOwnerAccountResolver(() => "acct_owner");
    await linkCanonicalOpenClawIdUserProfile({
      profileId: person.id,
      accountId: "acct_owner",
      email: "owner-person@id.test",
    });
    const ownerDevice = await connect(ownerDeviceOrigin);
    report.ownerDeviceProfileIsPerson = ownerDevice.profileId === person.id;
    const cutAt = Date.now();
    if (cutOff === "control") {
      report.cut = "none";
    } else if (cutOff === "admin-sets-null") {
      report.cut = await settle(
        admin.client.request("users.setRole", { profileId: memberProfile, role: null }),
      );
    } else if (cutOff === "owner-sets-reader" || cutOff === "owner-sets-null") {
      report.cut = await settle(
        owner.request("users.setRole", {
          profileId: memberProfile,
          role: cutOff === "owner-sets-reader" ? "reader" : null,
        }),
      );
    } else {
      const { link } = await owner.request<{ link: { seq: number } }>("openclawId.people", {});
      const statement = await signStatement(
        "MembershipChange",
        {
          claw_id: claw.clawId,
          seq: link.seq + 1,
          target: { op: "remove", account_id: people.member.account },
          issued_at: Math.floor(Date.now() / 1000),
        },
        claw.device,
      );
      report.cut = await settle(
        owner.request("openclawId.authority", { action: "submit", statement }),
      );
    }
    report.memberConnectionClosed = (await until(() => member.closeCode() !== undefined, 5000))
      ? member.closeCode()
      : "still open";
    report.adminConnectionUntouched = admin.closeCode() === undefined;
    if (cutOff === "admin-sets-null") {
      report.personRoleChange = await settle(
        admin.client.request("users.setRole", { profileId: person.id, role: "reader" }),
      ).then((result) => (result.ok ? "applied" : result.error));
      await sleep(500);
      report.ownerDeviceUntouched = {
        open: ownerDevice.closeCode() === undefined,
        adminCall: await settle(ownerDevice.client.request("device.pair.list", {})).then(
          (result) => (result.ok ? "allowed" : result.error),
        ),
      };
    }
    await until(() => [...holds.values()].every((hold) => hold.aborted), 3000);
    report.inFlightTurnAborted = holds.get("HOLD_TURN")?.aborted ?? "never started";
    report.childRunAborted = holds.get("CHILD_HOLD")?.aborted ?? "never started";
    for (const hold of holds.values()) {
      hold.release();
    }
    await sleep(4000);
    const after = (marker: string) =>
      seen.some((entry) => entry.marker === marker && entry.at >= cutAt);
    report.queuedFollowupRanAfterCut = after("QUEUED_FOLLOWUP");
    report.steeredInputRanAfterCut = after("STEERED_INPUT");
    report.steeredInputRanBeforeCut = seen.some(
      (entry) => entry.marker === "STEERED_INPUT" && entry.at < cutAt,
    );
    if (job) {
      report.cronAfterCut = await settle(
        owner.request("cron.run", { id: job.id, mode: "force" }),
      ).then((result) => (result.ok ? result.value : result.error));
      await until(() => after("CRON_RUN_MARKER"), 8000);
      report.cronTurnReachedModelAfterCut = after("CRON_RUN_MARKER");
      report.cronJobAfterCut = (await jobs()).find((candidate) => candidate.id === job!.id) ?? null;
      report.cronRuns = await settle(
        owner.request<{ entries?: unknown[] }>("cron.runs", { id: job.id, limit: 5 }),
      ).then((result) => (result.ok ? result.value : result.error));
    }
    const reconnect = await settle(connect(people.member.origin));
    report.reconnect = reconnect.ok
      ? { connected: true, scopes: reconnect.value.scopes ?? [] }
      : { connected: false, error: reconnect.error };
    return report;
  } finally {
    setOpenClawIdOwnerAccountResolver(undefined);
    for (const hold of holds.values()) {
      hold.release();
    }
    for (const client of clients) {
      await client.stopAndWait().catch(() => {});
    }
    await server?.close();
    intercepted.mockRestore();
    await closeProvider(provider);
    await state.cleanup();
  }
}

it.for<CutOff>([
  "control",
  "admin-sets-null",
  "owner-sets-reader",
  "owner-sets-null",
  "openclaw-id-remove",
])("cuts off an OpenClaw ID member's work (%s)", async (cutOff, { signal }) => {
  const report = await runScenario(cutOff, signal);
  // Assignment changes apply to tunnel connections and every retained source.
  expect(report.profileRoleApplies).toMatchObject({
    member: ["operator.approvals", "operator.read", "operator.write"],
    memberProfileId: true,
  });
  expect(report).toMatchObject({
    cronJobCreated: true,
    holdStarted: true,
    childStarted: true,
    adminConnectionUntouched: true,
    ownerDeviceProfileIsPerson: true,
  });
  const cut = cutOff !== "control";
  // A: tunnel connection closed, in-flight run revoked.
  expect(report.memberConnectionClosed).toBe(
    cutOff === "openclaw-id-remove" ? 1008 : cut ? 4001 : "still open",
  );
  expect(report.inFlightTurnAborted).toBe(cut);
  // B1-B3: queued/steered input, subagent child and the member's automation.
  expect(report.queuedFollowupRanAfterCut).toBe(!cut);
  expect(report.steeredInputRanAfterCut).toBe(!cut);
  // Membership removal refuses fresh sources but preserves an admitted recovered child.
  expect(report.childRunAborted).toBe(cut && cutOff !== "openclaw-id-remove");
  expect(report.cronTurnReachedModelAfterCut).toBe(!cut);
  if (cut) {
    expect(report.cronRuns).toMatchObject({
      entries: [
        { status: "error", error: expect.stringMatching(/created this automation was refused/) },
      ],
    });
  }
  if (cutOff === "admin-sets-null") {
    expect(report.ownerDeviceUntouched).toEqual({ open: true, adminCall: "allowed" });
  }
  // B5: reconnect.
  const reconnect = {
    control: { connected: true, scopes: ["operator.read", "operator.write", "operator.approvals"] },
    "admin-sets-null": { connected: false, error: expect.stringMatching(/Gateway access/) },
    "owner-sets-reader": { connected: true, scopes: ["operator.read"] },
    "owner-sets-null": { connected: false, error: expect.stringMatching(/Gateway access/) },
    "openclaw-id-remove": {
      connected: false,
      error: expect.stringMatching(/no longer has access to this claw/),
    },
  }[cutOff];
  expect(report.reconnect).toEqual(reconnect);
});
