import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ModelChoice } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { FastMode } from "../auto-reply/thinking.js";
import { isSyntheticGatewayCaller } from "./server-methods/gateway-personal-caller.js";
import type { GatewayClient } from "./server-methods/types.js";

/** Released native decoders accept only booleans and "auto". Never rewrite stored selection. */
export function prepareSessionFastModePresentation(client?: GatewayClient | null) {
  const supportsUltrafast =
    !client ||
    isSyntheticGatewayCaller(client) ||
    hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.ULTRAFAST);
  return (mode: FastMode | undefined): FastMode | undefined =>
    mode === "ultrafast" && !supportsUltrafast ? true : mode;
}

/** Catalog caches stay canonical; each recipient decodes only its negotiated speed values. */
export function projectModelFastModeCatalog<
  T extends { models?: ModelChoice[]; decisionModels?: ModelChoice[] },
>(payload: T, client?: GatewayClient | null): T {
  const present = prepareSessionFastModePresentation(client);
  if (present("ultrafast") !== true) {
    return payload;
  }
  const project = (models: ModelChoice[]) =>
    models.map((model) => {
      const runtimeChoices = model.runtimeChoices?.some(
        (choice) => choice.effectiveFastMode === "ultrafast",
      )
        ? model.runtimeChoices.map((choice) =>
            choice.effectiveFastMode === "ultrafast"
              ? { ...choice, effectiveFastMode: true }
              : choice,
          )
        : model.runtimeChoices;
      return model.effectiveFastMode !== "ultrafast" && runtimeChoices === model.runtimeChoices
        ? model
        : {
            ...model,
            ...(model.effectiveFastMode === "ultrafast" ? { effectiveFastMode: true } : {}),
            ...(runtimeChoices ? { runtimeChoices } : {}),
          };
    });
  return {
    ...payload,
    ...(payload.models ? { models: project(payload.models) } : {}),
    ...(payload.decisionModels ? { decisionModels: project(payload.decisionModels) } : {}),
  };
}
