// Gateway HTTP boundary helpers coordinate request and upgrade work with host suspension.
import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { waitForHttpRequestRejection } from "../../infra/http-request-lifecycle.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { rejectWebSocketUpgrade } from "../../shared/websocket-upgrade-reject.js";
import { getGatewayInstallationReplacement } from "../stale-install.js";

type GatewayBoundaryHandler = () => Promise<boolean> | boolean;
/** Generation-scoped fence owned by the Gateway's connection work. */
type GatewayTransportAdmissionFence = () => boolean;

async function runWithGatewayBoundaryWorkAdmission(
  origin: string,
  reject: () => void,
  run: GatewayBoundaryHandler,
  isTransportAdmissionClosed?: GatewayTransportAdmissionFence,
): Promise<boolean> {
  // A closing generation owns its own listeners: refuse new transport work before
  // process-global admission, which same-process successors still need open.
  const admission =
    isTransportAdmissionClosed?.() === true ? null : tryBeginGatewayRootWorkAdmission(origin);
  if (!admission) {
    reject();
    return true;
  }
  try {
    return await admission.run(async () => await run());
  } finally {
    admission.release();
  }
}

/** Writes the shared retryable refusal for new HTTP user work. */
function rejectGatewayHttpWorkServiceUnavailable(res: ServerResponse): void {
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "1");
  res.end(
    JSON.stringify({
      error: {
        message: "Gateway is temporarily unavailable while suspending or restarting",
        type: "service_unavailable",
        code: "gateway_unavailable",
      },
    }),
  );
}

/** Runs one HTTP user-work route under the same root fence as Gateway RPCs. */
export async function runWithGatewayHttpWorkAdmission(
  res: ServerResponse,
  run: GatewayBoundaryHandler,
  isTransportAdmissionClosed?: GatewayTransportAdmissionFence,
): Promise<boolean> {
  return await runWithGatewayBoundaryWorkAdmission(
    "http:request",
    () => rejectGatewayHttpWorkServiceUnavailable(res),
    async () => {
      try {
        return await run();
      } finally {
        await waitForHttpRequestRejection(res.req);
      }
    },
    isTransportAdmissionClosed,
  );
}

export function rejectGatewayUpgradeServiceUnavailable(
  socket: Pick<Duplex, "end" | "destroy">,
  body: string,
): void {
  const replacement = getGatewayInstallationReplacement();
  rejectWebSocketUpgrade(socket, {
    status: 503,
    body: {
      contentType: "text/plain; charset=utf-8",
      text: replacement ? `${body}. ${replacement.message}` : body,
    },
  });
}

/** Holds upgrade admission until one plugin handler owns or declines the socket. */
export async function runWithGatewayUpgradeWorkAdmission(
  socket: Duplex,
  run: GatewayBoundaryHandler,
  isTransportAdmissionClosed?: GatewayTransportAdmissionFence,
): Promise<boolean> {
  return await runWithGatewayBoundaryWorkAdmission(
    "http:upgrade",
    () => {
      rejectGatewayUpgradeServiceUnavailable(socket, "Gateway websocket admission closed");
    },
    run,
    isTransportAdmissionClosed,
  );
}
