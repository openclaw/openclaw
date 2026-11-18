import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { shouldPauseGatewayReconnect } from "../../packages/gateway-client/src/reconnect-policy.js";
import { writeConfigFile } from "../config/config.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as approvals from "../infra/device-pairing-approval.js";
import {
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import type { loadDeviceIdentity } from "./device-authz.test-helpers.js";
import { installGatewayTestHooks } from "./test-helpers.js";
import { describeWithLanNodePairingServer } from "./test-helpers.lan-pairing.js";

installGatewayTestHooks({ scope: "suite" });

const configurePairing = async (autoApproveCidrs?: string[], sshVerify?: false) => {
  await writeConfigFile({ gateway: { nodes: { pairing: { autoApproveCidrs, sshVerify } } } });
};
const pendingFor = async (deviceId: string) =>
  (await listDevicePairing()).pending.filter((entry) => entry.deviceId === deviceId);

async function approveIdentity(
  { identity: { deviceId }, publicKey }: ReturnType<typeof loadDeviceIdentity>,
  role: "node" | "operator",
  approvedVia?: "silent",
) {
  const request = await requestDevicePairing({ deviceId, publicKey, role, scopes: [] });
  await approvals.approveDevicePairing(request.request.requestId, {
    callerScopes: [],
    approvedVia,
  });
}

function expectPendingSurface(paired: Awaited<ReturnType<typeof getPairedDevice>>) {
  expect(paired?.nodeSurface).toBeUndefined();
  expect(paired?.pendingNodeSurface).toBeDefined();
}

describeWithLanNodePairingServer("gateway trusted CIDR node pairing auto-approve", (attempt) => {
  test.each([
    {
      identityName: "remote-node-earlier-silent-approval",
      run: async ({ loaded, connectNode }) => {
        await approveIdentity(loaded, "node", "silent");
        expect(await connectNode()).toMatchObject({ ok: true });
        const paired = await getPairedDevice(loaded.identity.deviceId);
        expect(paired?.approvedVia).toBe("silent");
        expectPendingSurface(paired);
      },
    },
    {
      identityName: "trusted-cidr-node-role-upgrade",
      configure: (lanIp) => configurePairing([`${lanIp}/32`], false),
      run: async ({ loaded, connectNode }) => {
        await approveIdentity(loaded, "operator");
        expect(await connectNode()).toMatchObject({
          ok: false,
          error: { details: { reason: "role-upgrade" } },
        });
        expect((await getPairedDevice(loaded.identity.deviceId))?.roles).toEqual(["operator"]);
        expect((await listDevicePairing()).pending).toEqual([
          expect.objectContaining({
            deviceId: loaded.identity.deviceId,
            isRepair: true,
            silent: false,
          }),
        ]);
      },
    },
    {
      identityName: "trusted-cidr-revoked-before-approval",
      configure: (lanIp) => configurePairing([`${lanIp}/32`], false),
      run: async ({ loaded, connectNode }) => {
        const approve = approvals.approveDevicePairing;
        using approval = vi
          .spyOn(approvals, "approveDevicePairing")
          .mockImplementation((requestId, options, baseDir) => {
            const current = getRuntimeConfigSnapshot();
            assert(current, "expected active Gateway config");
            setRuntimeConfigSnapshot({
              ...current,
              gateway: {
                ...current.gateway,
                nodes: { ...current.gateway?.nodes, pairing: { sshVerify: false } },
              },
            });
            return approve(requestId, options, baseDir);
          });
        const response = await connectNode();
        expect(approval).toHaveBeenCalledOnce();
        expect(response).toMatchObject({ ok: false, error: { code: "NOT_PAIRED" } });
        expect(await getPairedDevice(loaded.identity.deviceId)).toBeNull();
        expect(await pendingFor(loaded.identity.deviceId)).not.toHaveLength(0);
      },
    },
    {
      identityName: "trusted-cidr-default-off",
      // Disable SSH so the CIDR default never probes the runner itself.
      configure: () => configurePairing(undefined, false),
      run: async ({ loaded, connectNode }) => {
        const { deviceId } = loaded.identity;
        const res = await connectNode();
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("pairing required");
        const pending = await pendingFor(deviceId);
        expect(pending).toEqual([expect.objectContaining({ silent: false })]);
        expect(await getPairedDevice(deviceId)).toBeNull();
        const request = pending[0];
        assert(request, "expected a pending node pairing request");
        expect(res.error?.details).toMatchObject({
          code: "PAIRING_REQUIRED",
          reason: "not-paired",
          requestId: request.requestId,
          requestedRole: "node",
          recommendedNextStep: "wait_then_retry",
          retryable: true,
          pauseReconnect: false,
        });
        expect(shouldPauseGatewayReconnect({ details: res.error?.details })).toBe(false);

        const retry = await connectNode();
        expect(retry.ok).toBe(false);
        expect(retry.error?.details).toMatchObject({ requestId: request.requestId });
        expect(await getPairedDevice(deviceId)).toBeNull();
        expect(
          await approvals.approveDevicePairing(request.requestId, {
            callerScopes: ["operator.pairing"],
          }),
        ).toMatchObject({ status: "approved" });

        expect(await connectNode()).toMatchObject({
          ok: true,
          payload: { type: "hello-ok", auth: { role: "node", scopes: [] } },
        });
        expectPendingSurface(await getPairedDevice(deviceId));
      },
    },
    {
      identityName: "trusted-cidr-direct-lan-auto-approve",
      configure: (lanIp) => configurePairing([`${lanIp}/32`]),
      run: async ({ loaded, connectNode }) => {
        const res = await connectNode();
        expect(res).toMatchObject({ ok: true, payload: { type: "hello-ok" } });
        const pending = await pendingFor(loaded.identity.deviceId);
        expect(pending).toHaveLength(0);
        const paired = await getPairedDevice(loaded.identity.deviceId);
        expect(paired).toMatchObject({ role: "node", approvedVia: "trusted-cidr" });
        expect(paired?.approvedScopes ?? []).toStrictEqual([]);
        // Network-origin approval leaves capabilities pending for an operator (#128446).
        expectPendingSurface(paired);
      },
    },
  ] satisfies Parameters<typeof attempt>[0][])("$identityName", (scenario) => attempt(scenario));
});
