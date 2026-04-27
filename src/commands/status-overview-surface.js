import { buildGatewayStatusJsonPayload, buildStatusOverviewSurfaceRows, } from "./status-all/format.js";
export function buildStatusOverviewSurfaceFromScan(params) {
    return {
        cfg: params.scan.cfg,
        update: params.scan.update,
        tailscaleMode: params.scan.tailscaleMode,
        tailscaleDns: params.scan.tailscaleDns,
        tailscaleHttpsUrl: params.scan.tailscaleHttpsUrl,
        gatewayMode: params.scan.gatewayMode,
        remoteUrlMissing: params.scan.remoteUrlMissing,
        gatewayConnection: params.scan.gatewayConnection,
        gatewayReachable: params.scan.gatewayReachable,
        gatewayProbe: params.scan.gatewayProbe,
        gatewayProbeAuth: params.scan.gatewayProbeAuth,
        gatewayProbeAuthWarning: params.scan.gatewayProbeAuthWarning,
        gatewaySelf: params.scan.gatewaySelf,
        gatewayService: params.gatewayService,
        nodeService: params.nodeService,
        nodeOnlyGateway: params.nodeOnlyGateway,
    };
}
export function buildStatusOverviewSurfaceFromOverview(params) {
    return {
        cfg: params.overview.cfg,
        update: params.overview.update,
        tailscaleMode: params.overview.tailscaleMode,
        tailscaleDns: params.overview.tailscaleDns,
        tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
        gatewayMode: params.overview.gatewaySnapshot.gatewayMode,
        remoteUrlMissing: params.overview.gatewaySnapshot.remoteUrlMissing,
        gatewayConnection: params.overview.gatewaySnapshot.gatewayConnection,
        gatewayReachable: params.overview.gatewaySnapshot.gatewayReachable,
        gatewayProbe: params.overview.gatewaySnapshot.gatewayProbe,
        gatewayProbeAuth: params.overview.gatewaySnapshot.gatewayProbeAuth,
        gatewayProbeAuthWarning: params.overview.gatewaySnapshot.gatewayProbeAuthWarning,
        gatewaySelf: params.overview.gatewaySnapshot.gatewaySelf,
        gatewayService: params.gatewayService,
        nodeService: params.nodeService,
        nodeOnlyGateway: params.nodeOnlyGateway,
    };
}
export function buildStatusOverviewRowsFromSurface(params) {
    return buildStatusOverviewSurfaceRows({
        cfg: params.surface.cfg,
        update: params.surface.update,
        tailscaleMode: params.surface.tailscaleMode,
        tailscaleDns: params.surface.tailscaleDns,
        tailscaleHttpsUrl: params.surface.tailscaleHttpsUrl,
        tailscaleBackendState: params.tailscaleBackendState,
        includeBackendStateWhenOff: params.includeBackendStateWhenOff,
        includeBackendStateWhenOn: params.includeBackendStateWhenOn,
        includeDnsNameWhenOff: params.includeDnsNameWhenOff,
        decorateTailscaleOff: params.decorateTailscaleOff,
        decorateTailscaleWarn: params.decorateTailscaleWarn,
        gatewayMode: params.surface.gatewayMode,
        remoteUrlMissing: params.surface.remoteUrlMissing,
        gatewayConnection: params.surface.gatewayConnection,
        gatewayReachable: params.surface.gatewayReachable,
        gatewayProbe: params.surface.gatewayProbe,
        gatewayProbeAuth: params.surface.gatewayProbeAuth,
        gatewayProbeAuthWarning: params.surface.gatewayProbeAuthWarning,
        gatewaySelf: params.surface.gatewaySelf,
        gatewayService: params.surface.gatewayService,
        nodeService: params.surface.nodeService,
        nodeOnlyGateway: params.surface.nodeOnlyGateway,
        decorateOk: params.decorateOk,
        decorateWarn: params.decorateWarn,
        prefixRows: params.prefixRows,
        middleRows: params.middleRows,
        suffixRows: params.suffixRows,
        agentsValue: params.agentsValue,
        updateValue: params.updateValue,
        gatewayAuthWarningValue: params.gatewayAuthWarningValue,
        gatewaySelfFallbackValue: params.gatewaySelfFallbackValue,
    });
}
export function buildStatusGatewayJsonPayloadFromSurface(params) {
    return buildGatewayStatusJsonPayload({
        gatewayMode: params.surface.gatewayMode,
        gatewayConnection: params.surface.gatewayConnection,
        remoteUrlMissing: params.surface.remoteUrlMissing,
        gatewayReachable: params.surface.gatewayReachable,
        gatewayProbe: params.surface.gatewayProbe,
        gatewaySelf: params.surface.gatewaySelf,
        gatewayProbeAuthWarning: params.surface.gatewayProbeAuthWarning,
    });
}
