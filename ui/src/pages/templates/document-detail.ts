import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { isExactSemVer } from "../../../../src/templates/exact-version.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { currentDisplayConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { isTemplatesAvailable } from "./availability.ts";
import {
  beginTemplateDetailRead,
  retireTemplateDetailRead,
  type TemplateDetailRead,
} from "./detail-read.ts";
import type { TemplatesRouteData } from "./route.ts";

// start() synchronously calls the first foreground loader. A synthetic bridge
// query (or the same URL on a later visit) is not a document navigation.
const opening = new WeakMap<
  ApplicationContext,
  { location: RouteLocation; current: () => boolean }
>();
export function startTemplateDocument(
  context: ApplicationContext,
  location: RouteLocation,
  current: () => boolean,
  start: () => Promise<void>,
) {
  opening.set(context, { location, current });
  try {
    return start();
  } finally {
    opening.delete(context);
  }
}

function connecting(snapshot: ApplicationGatewaySnapshot) {
  return (
    !snapshot.offlineStable &&
    !snapshot.lastError &&
    !snapshot.hello &&
    (snapshot.phase === "connecting" || (snapshot.phase === "stopped" && !snapshot.client))
  );
}

// Offer exactly one missed loader read. Keep the normal loader's first chance;
// neither its return nor router startup waits for a connection or config here.
export function prepareConnectingDocument(
  context: ApplicationContext,
  options: RouteLoaderOptions,
  data: TemplatesRouteData,
  source: TemplateDetailRead["source"],
): (() => void) | undefined {
  const entry = opening.get(context);
  if (
    !entry ||
    entry.location.pathname !== data.location.pathname ||
    !source.version ||
    !isExactSemVer(source.version)
  ) {
    return undefined;
  }
  const { gateway, runtimeConfig, router, lifecycleAbortSignal } = context;
  const initial = gateway.snapshot;
  if (!connecting(initial)) {
    return undefined;
  }
  opening.delete(context);
  const owner = gatewayPresentationScope(gateway);
  const { signal } = options;
  let client = initial.client;
  let hello = initial.hello;
  let profile: string | null | undefined;
  let released = false;
  let active = true;
  let started = false;
  let read: TemplateDetailRead | undefined;
  const take = () => {
    active = false;
    stopGateway();
    stopConfig();
    stopRoute();
    stopNavigationAbort();
    stopLifecycleAbort?.();
    data.takeInitialDetail = undefined;
    return read;
  };
  const retire = () => {
    if (read) {
      retireTemplateDetailRead(read);
    }
    read = undefined;
    take();
  };
  const reconcile = () => {
    if (!active) {
      return;
    }
    const snapshot = gateway.snapshot;
    const { phase, selfUser } = snapshot;
    const state = router.getState();
    const target = state.pendingMatches[0] ?? state.matches[0];
    const config = runtimeConfig.state;
    const available = isTemplatesAvailable(config);
    const identity = selfUser === null ? null : selfUser?.id;
    // Same URL is insufficient: a revalidation, auth retry, identity switch or
    // denial cannot revive a receipt even when eligibility later returns.
    if (
      !entry.current() ||
      signal.aborted ||
      lifecycleAbortSignal?.aborted ||
      target?.abortController.signal !== signal ||
      target.status === "error" ||
      target.status === "notFound" ||
      gatewayPresentationScope(gateway) !== owner ||
      (client && snapshot.client !== client) ||
      (hello && snapshot.hello !== hello) ||
      (profile !== undefined && identity !== profile) ||
      snapshot.client?.offlineRecoveryRetired ||
      available === false ||
      config.lastError ||
      config.configValid === false ||
      (phase === "connected"
        ? !canCallGatewayMethod(snapshot, "templates.catalog.detail", "operator.read")
        : !connecting(snapshot) || hello)
    ) {
      retire();
      return;
    }
    client ??= snapshot.client;
    hello ??= snapshot.hello;
    if (identity !== undefined) {
      profile = identity;
    }
    if (started || !released) {
      return;
    }
    if (target.module !== undefined || !options.shouldRun()) {
      // Renderer won the race: its ordinary mounted read owns the visit.
      retire();
      return;
    }
    if (
      phase === "connected" &&
      available &&
      currentDisplayConfig(config) &&
      config.connected &&
      config.client === client &&
      !config.configNeedsApply
    ) {
      // request() may synchronously publish; claim before dispatch so a nested
      // observer cannot start another read or revive one retired during dispatch.
      started = true;
      const sent = beginTemplateDetailRead(gateway, source);
      if (active) {
        read = sent;
      } else if (sent) {
        retireTemplateDetailRead(sent);
      }
    }
  };
  const stopGateway = gateway.subscribe(reconcile);
  const stopConfig = runtimeConfig.subscribe(reconcile);
  const stopRoute = router.subscribe(reconcile);
  const stopNavigationAbort = listen(signal, "abort", retire, { once: true });
  const stopLifecycleAbort = lifecycleAbortSignal
    ? listen(lifecycleAbortSignal, "abort", retire, { once: true })
    : undefined;
  data.takeInitialDetail = take;
  reconcile();
  return () => {
    released = true;
    reconcile();
  };
}
