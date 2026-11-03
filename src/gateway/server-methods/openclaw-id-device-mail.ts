// Owner-only bridge for the local browser's D-signed Discovery mailbox traffic.
import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { DeviceMailRequest } from "../../../packages/openclaw-id-protocol/src/index.js";
import {
  resolveOpenClawIdClientChannel,
  resolveOpenClawIdClientPeerKey,
} from "../openclaw-id/channel.js";
import { relayDeviceMail } from "../openclaw-id/device-mail-relay.js";
import type { OpenClawIdService } from "../openclaw-id/service.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Relays only current owners; rechecks access after I/O before disclosing a mailbox response. */
export async function handleOpenClawIdDeviceMail(
  opts: GatewayRequestHandlerOptions,
  service: OpenClawIdService,
) {
  const deny = () =>
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Only an active owner device can use device mail"),
    );
  const owner = await service.prepareOwnerClientCheck(
    resolveOpenClawIdClientChannel(opts.client),
    resolveOpenClawIdClientPeerKey(opts.client),
  );
  if (!owner()) {
    deny();
    return;
  }
  // SAFETY: relayDeviceMail validates every field and the operation before relaying.
  const request = opts.params as unknown as Omit<DeviceMailRequest, "operation"> & {
    operation: string;
  };
  const link = await service.linkStatus();
  if (!owner() || !link.linked || !link.clawId) {
    deny();
    return;
  }
  if (request.operation === "context") {
    const binding = await service.ownerBinding();
    if (!owner()) {
      deny();
      return;
    }
    opts.respond(true, { link, binding });
    return;
  }
  const baseUrl = opts.context.getRuntimeConfig().gateway?.openclawId?.discoveryUrl;
  if (!baseUrl) {
    deny();
    return;
  }
  try {
    const result = await relayDeviceMail({
      baseUrl,
      clawId: link.clawId,
      // SAFETY: relayDeviceMail validates the operation and every field before relaying.
      request: request as DeviceMailRequest,
      activeCertificates: (link.ownerDevices ?? []).map((device) => device.cert),
      signal: opts.client?.connectionSignal,
    });
    // Recheck D as well as the transport: loopback stays privileged after its old D is revoked.
    const settled = await service.linkStatus();
    const deviceStillActive =
      settled.clawId === link.clawId &&
      settled.ownerDevices?.some((device) => isDeepStrictEqual(device.cert, request.certificate));
    if (!owner() || !deviceStillActive || opts.client?.connectionSignal?.aborted) {
      deny();
      return;
    }
    opts.respond(true, result);
  } catch {
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "Owner-device mail could not be delivered"),
    );
  }
}
