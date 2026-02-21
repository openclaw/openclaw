import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { CORE_GATEWAY_METHODS, listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";

const INTERNAL_ONLY_METHODS = new Set([
  "connect",
  "chat.inject",
  "web.login.start",
  "web.login.wait",
  "sessions.resolve",
  "push.test",
  "poll",
  "sessions.usage",
  "sessions.usage.timeseries",
  "sessions.usage.logs",
]);

describe("gateway method catalog consistency", () => {
  let previousRegistry = getActivePluginRegistry();

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
  });

  afterEach(() => {
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
      return;
    }
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("matches listed public methods to implemented handlers", () => {
    const supplementalHandlers = createExecApprovalHandlers(new ExecApprovalManager());
    const implementedHandlers = new Set([
      ...Object.keys(coreGatewayHandlers),
      ...Object.keys(supplementalHandlers),
    ]);

    const missingPublicMethods = CORE_GATEWAY_METHODS.filter(
      (method) => !implementedHandlers.has(method),
    );
    expect(missingPublicMethods).toEqual([]);

    const unexpectedPublicMethods = Array.from(implementedHandlers).filter(
      (method) => !CORE_GATEWAY_METHODS.includes(method) && !INTERNAL_ONLY_METHODS.has(method),
    );
    expect(unexpectedPublicMethods).toEqual([]);
  });

  it("returns only core catalog methods when no channel plugins register extras", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(listGatewayMethods()).toEqual(CORE_GATEWAY_METHODS);
  });
});
