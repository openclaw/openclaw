import { describe, expect, it } from "vitest";
import { resolvePluginActivationDecisionShared } from "./config-activation-shared.js";

const noop = () => false;

function resolveDecision(params: {
  id: string;
  origin: string;
  enabled?: boolean;
  deny?: string[];
  allow?: string[];
  entryEnabled?: boolean;
}) {
  return resolvePluginActivationDecisionShared({
    id: params.id,
    origin: params.origin,
    config: {
      enabled: params.enabled ?? true,
      allow: params.allow ?? [],
      deny: params.deny ?? [],
      slots: {},
      entries: params.entryEnabled !== undefined
        ? { [params.id]: { enabled: params.entryEnabled } }
        : {},
    },
    isBundledChannelEnabledByChannelConfig: noop,
  });
}

describe("system origin activation bypass", () => {
  it("system plugins are always enabled", () => {
    const decision = resolveDecision({ id: "sys-plugin", origin: "system" });
    expect(decision.enabled).toBe(true);
    expect(decision.activated).toBe(true);
    expect(decision.explicitlyEnabled).toBe(true);
  });

  it("system plugins ignore plugins.enabled=false", () => {
    const decision = resolveDecision({
      id: "sys-plugin",
      origin: "system",
      enabled: false,
    });
    expect(decision.enabled).toBe(true);
    expect(decision.activated).toBe(true);
  });

  it("system plugins ignore deny list", () => {
    const decision = resolveDecision({
      id: "sys-plugin",
      origin: "system",
      deny: ["sys-plugin"],
    });
    expect(decision.enabled).toBe(true);
    expect(decision.activated).toBe(true);
  });

  it("system plugins ignore allowlist exclusion", () => {
    const decision = resolveDecision({
      id: "sys-plugin",
      origin: "system",
      allow: ["some-other-plugin"],
    });
    expect(decision.enabled).toBe(true);
    expect(decision.activated).toBe(true);
  });

  it("system plugins ignore per-entry disabled", () => {
    const decision = resolveDecision({
      id: "sys-plugin",
      origin: "system",
      entryEnabled: false,
    });
    expect(decision.enabled).toBe(true);
    expect(decision.activated).toBe(true);
  });

  it("system plugins ignore all restrictions combined", () => {
    const decision = resolveDecision({
      id: "sys-plugin",
      origin: "system",
      enabled: false,
      deny: ["sys-plugin"],
      allow: ["other"],
      entryEnabled: false,
    });
    expect(decision.enabled).toBe(true);
    expect(decision.activated).toBe(true);
  });

  it("non-system plugins are still blocked by deny list", () => {
    const decision = resolveDecision({
      id: "user-plugin",
      origin: "global",
      deny: ["user-plugin"],
    });
    expect(decision.enabled).toBe(false);
  });

  it("non-system plugins are still blocked by plugins.enabled=false", () => {
    const decision = resolveDecision({
      id: "user-plugin",
      origin: "global",
      enabled: false,
    });
    expect(decision.enabled).toBe(false);
  });
});
