import { afterEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  applyModelRuntimeDirective,
  resolveModelRuntimeDirective,
} from "./directive-handling.model-runtime.js";

const baseConfig = {} as OpenClawConfig;

function configWith(plugins: NonNullable<OpenClawConfig["plugins"]>): OpenClawConfig {
  return { plugins } as OpenClawConfig;
}

describe("resolveModelRuntimeDirective app-server owner availability", () => {
  it("accepts a bridge runtime whose owner plugin is available", () => {
    expect(
      resolveModelRuntimeDirective({
        rawRuntime: "copilot",
        provider: "github-copilot",
        cfg: baseConfig,
      }),
    ).toEqual({ kind: "set", runtime: "copilot" });
  });

  it("rejects a bridge runtime whose owner plugin is disabled", () => {
    const resolution = resolveModelRuntimeDirective({
      rawRuntime: "copilot",
      provider: "github-copilot",
      cfg: configWith({ entries: { copilot: { enabled: false } } }),
    });

    expect(resolution.kind).toBe("invalid");
    expect(resolution.kind === "invalid" && resolution.errorText).toContain(
      'no enabled plugin owns agent harness "copilot"',
    );
  });

  it("rejects a bridge runtime excluded by a restrictive plugin allowlist", () => {
    expect(
      resolveModelRuntimeDirective({
        rawRuntime: "copilot",
        provider: "github-copilot",
        cfg: configWith({ allow: ["telegram"] }),
      }).kind,
    ).toBe("invalid");
  });

  it("persists nothing when a runtime directive is rejected", () => {
    const entry: { agentRuntimeOverride?: string } = {};
    const resolution = resolveModelRuntimeDirective({
      rawRuntime: "copilot",
      provider: "github-copilot",
      cfg: configWith({ entries: { copilot: { enabled: false } } }),
    });

    expect(applyModelRuntimeDirective(entry, resolution)).toEqual({ updated: false });
    expect(entry.agentRuntimeOverride).toBeUndefined();
  });

  it("does not gate the built-in runtime on a harness owner plugin", () => {
    expect(
      resolveModelRuntimeDirective({
        rawRuntime: "openclaw",
        provider: "github-copilot",
        cfg: configWith({ entries: { copilot: { enabled: false } } }),
      }),
    ).toEqual({ kind: "set", runtime: "openclaw" });
  });

  it("keeps the unsupported-pairing message for an incompatible runtime", () => {
    // Codex is the one harness whose applicability is closed on `main`
    // (`codex`/`openai` only), so it is the honest example of an incompatible
    // pairing. `copilot` is NOT: see the custom-provider cases below.
    const resolution = resolveModelRuntimeDirective({
      rawRuntime: "codex",
      provider: "anthropic",
      cfg: baseConfig,
    });

    expect(resolution.kind).toBe("invalid");
    expect(resolution.kind === "invalid" && resolution.errorText).toBe(
      'Runtime "codex" is not supported for anthropic.',
    );
  });
});

describe("resolveModelRuntimeDirective custom-provider applicability", () => {
  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  // A binding row is additive chooser-discovery data, not an exclusive claim
  // that its runtime serves only that one provider. `main` answers an unowned
  // provider through the canonical applicability owner (registered harness, then
  // manifest), and these pin that this branch does not narrow that.
  it("accepts an explicit bound runtime for a provider outside its binding row", () => {
    expect(
      resolveModelRuntimeDirective({
        rawRuntime: "copilot",
        provider: "proof-byok",
        cfg: baseConfig,
      }),
    ).toEqual({ kind: "set", runtime: "copilot" });
  });

  it("preserves an inherited compatible pin and its native-runtime consent", () => {
    const entry = { agentRuntimeOverride: "copilot", nativeRuntimeConsent: "copilot" };
    const resolution = resolveModelRuntimeDirective({
      provider: "proof-byok",
      cfg: baseConfig,
      sessionEntry: entry,
    });

    expect(resolution).toEqual({ kind: "unchanged" });
    expect(applyModelRuntimeDirective(entry, resolution)).toEqual({ updated: false });
    expect(entry).toEqual({ agentRuntimeOverride: "copilot", nativeRuntimeConsent: "copilot" });
  });

  it("recognises a dynamic harness owner without probing CLI setup discovery", () => {
    // The native `/model` fast path forbids synchronous plugin setup discovery
    // (see get-reply-native-slash-fast-path.test.ts, which stubs the same seam
    // to throw). `acp-opencode` is compatible through manifest discovery but is
    // absent from the fixed app-server binding table, so gating the CLI probe on
    // that table alone let it fall straight into the forbidden path.
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => {
        throw new Error("runtime directive attempted synchronous CLI setup discovery");
      },
    });

    expect(
      resolveModelRuntimeDirective({
        rawRuntime: "acp-opencode",
        provider: "zai",
        cfg: baseConfig,
      }),
    ).toEqual({ kind: "set", runtime: "acp-opencode" });
  });

  it("still clears an inherited pin the provider genuinely cannot use", () => {
    const entry: { agentRuntimeOverride?: string; nativeRuntimeConsent?: string } = {
      agentRuntimeOverride: "codex",
      nativeRuntimeConsent: "codex",
    };
    const resolution = resolveModelRuntimeDirective({
      provider: "proof-byok",
      cfg: baseConfig,
      sessionEntry: entry,
    });

    expect(resolution).toEqual({ kind: "clear" });
    applyModelRuntimeDirective(entry, resolution);
    expect(entry).toEqual({});
  });
});
