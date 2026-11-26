import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

type Client = Awaited<ReturnType<typeof connectGatewayClient>>;

it("enforces invitation-only permission ceilings and per-turn approval audiences over real Gateway RPC", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async (fixture) => {
      const { state, gateway, sender: admin, invited, alice, carol, events } = fixture;
      const teammate = gateway.client;
      const creator = await connectGatewayClient({
        signal,
        url: `wss://127.0.0.1:${gateway.port}`,
        tlsFingerprint: fixture.tlsFingerprint,
        origin: fixture.origin,
        edgeAuthHeaders: fixture.headers("alice@committed-mention.example.test"),
        clientName: "openclaw-control-ui",
        mode: "webchat",
        scopes: ["operator.read", "operator.write", "operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        deviceIdentity: loadOrCreateDeviceIdentity({
          path: state.path("creator-device", "client", "credentials.sqlite"),
        }),
      });
      try {
        expect(
          (await creator.request<{ profile: { id: string } }>("users.self", {})).profile.id,
        ).toBe(alice.id);
        expect(
          (await admin.request<{ profile: { id: string } }>("users.self", {})).profile.id,
        ).not.toBe(alice.id);
        const { key } = await creator.request<{ key: string }>("sessions.create", {
          visibility: "shared",
          permissionMode: "workspace",
        });
        await admin.request("session.members.add", { sessionKey: key, identityId: carol.id });
        for (const member of [invited]) {
          await expect(
            member.request("sessions.patch", { key, permissionMode: "guarded" }),
          ).resolves.toBeDefined();
          await expect(
            member.request("sessions.patch", { key, permissionMode: "workspace" }),
          ).rejects.toThrow(/Only the session creator or an admin can loosen/);
          await expect(
            member.request("sessions.patch", { key, permissionMode: null }),
          ).rejects.toThrow(/Only the session creator or an admin can loosen/);
          await expect(
            member.request("sessions.create", { key, permissionMode: "workspace" }),
          ).rejects.toThrow(/Only the session creator or an admin can loosen/);
          await expect(
            member.request("sessions.patch", { key, permissionMode: "full" }),
          ).rejects.toThrow(/operator.admin/);
          await expect(
            member.request("sessions.patch", { key, sandboxMode: "off" }),
          ).rejects.toThrow(/operator.admin/);
          const batch = await member.request<{
            outcomes: Array<{ ok: boolean; error?: { message: string } }>;
          }>("sessions.patchMany", { targets: [{ key }], patch: { permissionMode: "workspace" } });
          expect(batch.outcomes).toMatchObject([
            {
              ok: false,
              error: {
                message: expect.stringMatching(/Only the session creator or an admin can loosen/),
              },
            },
          ]);
          await expect(
            member.request("sessions.patch", { key, permissionMode: "read-only" }),
          ).resolves.toBeDefined();
          await expect(
            member.request("sessions.patch", { key, permissionMode: "guarded" }),
          ).rejects.toThrow(/Only the session creator or an admin can loosen/);
          await creator.request("sessions.patch", { key, permissionMode: "workspace" });
        }
        for (const member of [invited]) {
          await creator.request("sessions.patch", { key, permissionMode: null });
          for (const permissionMode of ["guarded", "workspace"]) {
            await expect(member.request("sessions.patch", { key, permissionMode })).rejects.toThrow(
              /Only the session creator or an admin can loosen/,
            );
          }
          await expect(
            member.request("sessions.patch", { key, permissionMode: "read-only" }),
          ).resolves.toBeDefined();
        }
        await creator.request("sessions.patch", { key, permissionMode: null });
        await admin.request("sessions.patch", { key, permissionMode: "full" });
        await creator.request("sessions.patch", { key, permissionMode: "guarded" });

        const main = await creator.request<{ key: string }>("sessions.create", {
          key: "agent:main:main",
          visibility: "shared",
          permissionMode: "guarded",
        });
        await admin.request("session.members.add", { sessionKey: main.key, identityId: carol.id });
        const resetMain = { agentId: "main", parentSessionKey: main.key, emitCommandHooks: true };
        for (const member of [invited]) {
          await expect(member.request("sessions.create", resetMain)).rejects.toThrow(
            /Only the session creator or an admin can loosen/,
          );
        }
        await expect(creator.request("sessions.create", resetMain)).resolves.toBeDefined();

        const listed = (client: Client) =>
          client.request<Array<{ id: string }>>("exec.approval.list", {});
        const resolve = (client: Client, id: string, generic = false) =>
          client.request(generic ? "approval.resolve" : "exec.approval.resolve", {
            id,
            decision: "deny",
          });
        const requested = () =>
          events.sender
            .filter((event) => event.event === "exec.approval.requested")
            .map((event) => (event.payload as { id: string }).id);
        for (const [raiser, resolver] of [
          [invited, invited],
          [teammate, teammate],
          [creator, creator],
          [teammate, admin],
        ] as const) {
          const previous = new Set(requested());
          const { runId } = await raiser.request<{ runId: string }>("chat.send", {
            sessionKey: key,
            message: "please RUN_EXEC",
            idempotencyKey: randomUUID(),
          });
          await expect
            .poll(() => requested().find((id) => !previous.has(id)), { timeout: 30_000 })
            .toBeDefined();
          const id = requested().find((candidate) => !previous.has(candidate))!;
          for (const member of [invited, teammate]) {
            const own = member === raiser;
            expect((await listed(member)).some((record) => record.id === id)).toBe(own);
            const replay = await member.request<{
              approvalReplay: { approvals: Array<{ id: string }> };
            }>("sessions.messages.subscribe", { key, includeApprovals: true });
            expect(replay.approvalReplay.approvals.some((record) => record.id === id)).toBe(own);
            const memberEvents = member === invited ? events.invited : events.guest;
            expect(
              memberEvents.some(
                (event) =>
                  event.event === "exec.approval.requested" &&
                  (event.payload as { id?: string }).id === id,
              ),
            ).toBe(own);
            if (!own) {
              await expect(member.request("approval.get", { id })).rejects.toThrow(/not found/);
              await expect(resolve(member, id)).rejects.toThrow(/unknown or expired/);
              await expect(resolve(member, id, true)).rejects.toThrow(/not found/);
            }
          }
          expect((await listed(creator)).some((record) => record.id === id)).toBe(
            raiser === creator,
          );
          expect((await listed(admin)).some((record) => record.id === id)).toBe(true);
          await expect(resolve(resolver, id, resolver === creator)).resolves.toBeDefined();
          await admin.request("agent.wait", { runId, timeoutMs: 30_000 });
          for (const member of [invited, teammate]) {
            const memberEvents = member === invited ? events.invited : events.guest;
            expect(
              memberEvents.some(
                (event) =>
                  event.event === "exec.approval.resolved" &&
                  (event.payload as { id?: string }).id === id,
              ),
            ).toBe(member === raiser);
          }
        }
      } finally {
        await creator.stopAndWait();
      }
    },
    { approvalOwnership: true },
  );
});
