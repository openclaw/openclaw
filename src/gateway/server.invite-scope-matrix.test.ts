import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as profileWrites from "../state/user-profile-writes.js";
import { prepareIosApprovalPushAuthority } from "./ios-approval-push-authority.js";
import {
  actors,
  matrixChecks,
  requestMatrixApproval,
  reviewScopes,
  withMatrixGateway,
  type MatrixClient,
} from "./server.invite-scope-matrix.test-support.js";

const listed = async (client: MatrixClient, id: string) =>
  (await client.request<Array<{ id: string }>>("exec.approval.list", {})).some(
    (item) => item.id === id,
  );
const resolve = (client: MatrixClient, id: string) =>
  client.request("approval.resolve", { id, decision: "deny" });

// Expectations are pinned to origin/main e72860564bdf, not to the new ownership helper.
// Legacy lists use requester-device binding; generic get/resolve accept an unbound reviewer.
// Only invited-role members lose others' approvals and permission loosening/reset-to-default.
it("limits the new restrictions to invited members across real Gateway RPC roles", async ({
  signal,
}) => {
  const matrix = matrixChecks();
  try {
    await withMatrixGateway(signal, true, async ({ admin, connect, profiles }) => {
      const clients = new Map<string, Awaited<ReturnType<typeof connect>>>();
      for (const actor of actors) {
        const connected = await connect(actor.name, [...actor.scopes]);
        clients.set(actor.name, connected);
        expect(
          (await connected.client.request<{ profile: { id: string } }>("users.self", {})).profile
            .id,
        ).toBe(profiles.get(actor.name));
      }
      const creator = clients.get("creator")!.client;
      const { key } = await creator.request<{ key: string }>("sessions.create", {
        visibility: "shared",
        permissionMode: "workspace",
      });
      for (const actor of actors.filter((candidate) => candidate.member)) {
        await admin.request("session.members.add", {
          sessionKey: key,
          identityId: profiles.get(actor.name),
        });
      }
      for (const actor of actors) {
        const { client, deviceId } = clients.get(actor.name)!;
        const isAdmin = actor.name === "admin";
        const isCreator = actor.name === "creator";
        const restricted = actor.cap === "invited" && actor.member;
        const approves = isAdmin || actor.scopes.some((scope) => scope === "operator.approvals");
        const writes = isAdmin || actor.scopes.some((scope) => scope === "operator.write");
        const participates = isCreator || isAdmin || actor.cap === "write" || actor.member;
        const canPatch = writes && participates;
        const canResolve = approves && participates;
        for (const [column, initial, permissionMode] of [
          ["loosen", "guarded", "workspace"],
          ["default", "workspace", null],
          ["tighten", "workspace", "guarded"],
        ] as const) {
          await admin.request("sessions.patch", { key, permissionMode: initial });
          await matrix.check(
            actor.name,
            column,
            canPatch,
            canPatch && (!restricted || column === "tighten"),
            () => client.request("sessions.patch", { key, permissionMode }),
          );
        }
        // A fresh approval per resolver prevents another row's verdict changing this row's truth.
        const other = await requestMatrixApproval(admin, key);
        await matrix.check(
          actor.name,
          "other.list (exact requester device)",
          isAdmin,
          isAdmin,
          () => listed(client, other.id),
        );
        await matrix.check(
          actor.name,
          "other.get (unbound reviewer)",
          approves,
          approves && !restricted,
          () => client.request("approval.get", { id: other.id }),
        );
        // Boundary: real pairing/token owners plus production offline iOS authority; no APNs delivery.
        using otherPush = await prepareIosApprovalPushAuthority(other);
        await matrix.check(
          actor.name,
          "other.push eligibility (offline device)",
          isAdmin,
          isAdmin,
          () => otherPush.canSend(deviceId),
        );
        const resolved = await matrix.check(
          actor.name,
          "other.resolve (unbound reviewer)",
          canResolve,
          canResolve && !restricted,
          () => resolve(client, other.id),
        );
        if (!resolved) {
          await resolve(admin, other.id);
        }
        if (approves) {
          const own = await requestMatrixApproval(client, key);
          await matrix.check(actor.name, "own.list", true, true, () => listed(client, own.id));
          using ownPush = await prepareIosApprovalPushAuthority(own);
          await matrix.check(actor.name, "own.push eligibility (offline device)", true, true, () =>
            ownPush.canSend(deviceId),
          );
          const ownResolved = await matrix.check(
            actor.name,
            "own.resolve",
            canResolve,
            canResolve,
            () => resolve(client, own.id),
          );
          if (!ownResolved) {
            await resolve(admin, own.id);
          }
        } else {
          // Missing approval scope is still authoritative, including for the actor's own ID.
          await matrix.check(actor.name, "own.request (scope control)", false, false, () =>
            requestMatrixApproval(client, key),
          );
          await matrix.check(actor.name, "own.list (scope control)", false, false, () =>
            listed(client, other.id),
          );
          await matrix.check(actor.name, "own.resolve (scope control)", false, false, () =>
            resolve(client, other.id),
          );
        }
      }
      // Role alone is not membership: an uninvited actor still cannot address the session.
      const outsider = clients.get("invited-both")!.client;
      await admin.request("session.members.remove", {
        sessionKey: key,
        identityId: profiles.get("invited-both"),
      });
      await matrix.check("invited-nonmember", "tighten", false, false, () =>
        outsider.request("sessions.patch", { key, permissionMode: "read-only" }),
      );
      const inaccessible = await requestMatrixApproval(admin, key);
      await matrix.check("invited-nonmember", "other.get", false, false, () =>
        outsider.request("approval.get", { id: inaccessible.id }),
      );
      await resolve(admin, inaccessible.id);
    });
  } finally {
    matrix.report();
  }
});

it("preserves non-ID owner, unprofiled-device, iOS, sessionless-node and deleted-session behavior", async ({
  signal,
}) => {
  const matrix = matrixChecks();
  try {
    await withMatrixGateway(signal, false, async ({ admin, connect }) => {
      const owner = await connect("legacy-owner", reviewScopes);
      expect(
        (await owner.client.request<{ profile: { id: string } }>("users.self", {})).profile.id,
      ).toBe("gateway-owner");
      // Fault only the optional attribution acquisition; handshake, device pairing, scopes and RPCs stay real.
      let unprofiled: Awaited<ReturnType<typeof connect>>;
      {
        using acquisitionFailure = vi
          .spyOn(profileWrites, "ensureCanonicalGatewayOwnerProfile")
          .mockRejectedValueOnce(new Error("matrix owner attribution unavailable"));
        unprofiled = await connect("unprofiled-device", reviewScopes);
        expect(acquisitionFailure).toHaveBeenCalledOnce();
      }
      await expect(unprofiled.client.request("users.self", {})).rejects.toThrow(
        /requires an authenticated user/,
      );
      const ios = await connect("nonadmin-ios", ["operator.read", "operator.approvals"], true);
      const key = `agent:main:matrix-legacy-${randomUUID()}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: randomUUID(),
          updatedAt: Date.now(),
          visibility: "shared",
          permissionMode: "workspace",
        },
      );
      for (const [name, actor, writes] of [
        ["legacy-owner-no-creator", owner, true],
        ["unprofiled-device", unprofiled, true],
        ["nonadmin-ios", ios, false],
      ] as const) {
        for (const [column, initial, permissionMode] of [
          ["loosen", "guarded", "workspace"],
          ["default", "workspace", null],
          ["tighten", "workspace", "guarded"],
        ] as const) {
          await admin.request("sessions.patch", { key, permissionMode: initial });
          await matrix.check(name, column, writes, writes, () =>
            actor.client.request("sessions.patch", { key, permissionMode }),
          );
        }
        const other = await requestMatrixApproval(admin, key);
        await matrix.check(name, "other.list (different device)", false, false, () =>
          listed(actor.client, other.id),
        );
        await matrix.check(name, "other.get (unbound reviewer)", true, true, () =>
          actor.client.request("approval.get", { id: other.id }),
        );
        const otherResolved = await matrix.check(
          name,
          "other.resolve (unbound reviewer)",
          true,
          true,
          () => resolve(actor.client, other.id),
        );
        if (!otherResolved) {
          await resolve(admin, other.id);
        }
        const own = await requestMatrixApproval(actor.client, key);
        await matrix.check(name, "own.list", true, true, () => listed(actor.client, own.id));
        using push = await prepareIosApprovalPushAuthority(own);
        await matrix.check(name, "own.push eligibility (offline device, no APNs)", true, true, () =>
          push.canSend(actor.deviceId),
        );
        // Exact reviewer binding remains required even outside the invited-member rule.
        using excludedPush = await prepareIosApprovalPushAuthority({
          ...own,
          requestedByDeviceId: "different-device",
          approvalReviewerDeviceIds: ["different-reviewer"],
        });
        await matrix.check(name, "push reviewer/device mismatch", false, false, () =>
          excludedPush.canSend(actor.deviceId),
        );
        const ownResolved = await matrix.check(name, "own.resolve", true, true, () =>
          resolve(actor.client, own.id),
        );
        if (!ownResolved) {
          await resolve(admin, own.id);
        }
      }
      const node = await requestMatrixApproval(owner.client, undefined, true);
      await matrix.check("sessionless-node", "own.list", true, true, () =>
        listed(owner.client, node.id),
      );
      await matrix.check("sessionless-node", "own.get", true, true, () =>
        owner.client.request("approval.get", { id: node.id }),
      );
      const nodeResolved = await matrix.check(
        "sessionless-node",
        "own.resolve (legacy RPC)",
        true,
        true,
        () => owner.client.request("exec.approval.resolve", { id: node.id, decision: "deny" }),
      );
      if (!nodeResolved) {
        await resolve(admin, node.id);
      }
      const deleted = await requestMatrixApproval(owner.client, key);
      await resolve(admin, deleted.id);
      await admin.request("sessions.delete", { key });
      await matrix.check("deleted-session", "terminal history", true, true, async () =>
        (
          await owner.client.request<{ items: Array<{ id: string }> }>("approval.history", {})
        ).items.some((record) => record.id === deleted.id),
      );
      await matrix.check("deleted-session", "terminal get", true, true, () =>
        owner.client.request("approval.get", { id: deleted.id }),
      );
    });
  } finally {
    matrix.report();
  }
});
