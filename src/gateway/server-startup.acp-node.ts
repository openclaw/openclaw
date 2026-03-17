import { getAcpGatewayNodeRuntime } from "../acp/store/gateway-events.js";
import { AcpGatewayStore } from "../acp/store/store.js";
import type { AcpGatewayRunDeliveryTargetRecord } from "../acp/store/types.js";
import type { AcpDispatchDeliveryCoordinator } from "../auto-reply/reply/dispatch-acp-delivery.js";
import {
  AcpDurableProjectionService,
  getAcpDurableProjectionService,
} from "../auto-reply/reply/dispatch-acp-replay.js";
import type { OpenClawConfig } from "../config/config.js";

export async function startAcpNodeProjectionRecovery(params: {
  cfg: OpenClawConfig;
  shouldSendToolSummaries?: boolean;
  store?: AcpGatewayStore;
  coordinatorFactory?: (params: {
    target: AcpGatewayRunDeliveryTargetRecord;
    restartMode: boolean;
  }) => AcpDispatchDeliveryCoordinator;
}): Promise<{ started: string[] }> {
  const gatewayRuntime = params.store ? null : getAcpGatewayNodeRuntime();
  const store = params.store ?? gatewayRuntime?.store;
  if (!store) {
    return { started: [] };
  }
  const coordinatorFactory =
    params.coordinatorFactory ??
    (await (async () => {
      const { createAcpDispatchDeliveryCoordinator } =
        await import("../auto-reply/reply/dispatch-acp-delivery.js");
      return ({
        target,
        restartMode,
      }: {
        target: AcpGatewayRunDeliveryTargetRecord;
        restartMode: boolean;
      }) =>
        createAcpDispatchDeliveryCoordinator({
          cfg: params.cfg,
          target,
          inboundAudio: target.inboundAudio === true,
          sessionTtsAuto: target.sessionTtsAuto,
          ttsChannel: target.ttsChannel,
          shouldRouteToOriginating: false,
          restartMode,
        });
    })());
  const service =
    params.store || params.coordinatorFactory
      ? new AcpDurableProjectionService({
          store,
          coordinatorFactory,
        })
      : getAcpDurableProjectionService({
          store,
          coordinatorFactory,
        });
  return await service.resumeAll({
    cfg: params.cfg,
    shouldSendToolSummaries: params.shouldSendToolSummaries ?? true,
  });
}
