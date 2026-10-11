import type { RemoteControlUiIngressContext } from "./remote-control-ui-context.js";

export function createRemoteControlUiIngressTestContext(
  overrides: Partial<RemoteControlUiIngressContext> = {},
): RemoteControlUiIngressContext {
  return Object.freeze({
    pluginId: "remote-ui-test",
    audienceId: "test-grant",
    publicOrigin: "https://ui.example.test",
    sandboxOrigin: "https://sandbox.example.test",
    operatorScopeCeiling: ["operator.read", "operator.write"] as const,
    frameAncestors: ["https://host.example.test", "codex-sandbox:"],
    signal: new AbortController().signal,
    assertCurrent() {},
    trackWork: <T>(work: Promise<T>) => work,
    ...overrides,
  });
}
