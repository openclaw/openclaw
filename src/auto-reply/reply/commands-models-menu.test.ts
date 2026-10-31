import { describe, expect, it } from "vitest";
import {
  buildModelsMenu,
  resolveModelSelectionAuthBlock,
  type ModelReadiness,
} from "./commands-models-menu.js";

function buildMenu(params: {
  readiness: Record<string, ModelReadiness>;
  loginProviders?: string[];
  providerLogins?: Record<string, { methodId: string; label: string }>;
}) {
  const byProvider = new Map<string, Set<string>>();
  for (const key of Object.keys(params.readiness)) {
    const slash = key.indexOf("/");
    const provider = key.slice(0, slash);
    const model = key.slice(slash + 1);
    byProvider.set(provider, new Set([...(byProvider.get(provider) ?? []), model]));
  }
  return buildModelsMenu({
    byProvider,
    modelNames: new Map(),
    modelAvailability: new Map(Object.entries(params.readiness)),
    loginProviders: new Set(params.loginProviders ?? []),
    providerLogins: new Map(Object.entries(params.providerLogins ?? {})),
  });
}

describe("resolveModelSelectionAuthBlock", () => {
  it("blocks a model that still needs sign-in and names the provider login step", () => {
    const menu = buildMenu({
      readiness: {
        "meta/muse-spark-1.3": { availability: false, unavailableReason: "missing-auth" },
      },
      loginProviders: ["meta"],
    });
    const block = resolveModelSelectionAuthBlock({
      menu,
      provider: "meta",
      model: "muse-spark-1.3",
    });
    expect(block?.label).toBe("Sign-in needed");
    expect(block?.notice).toBe("meta: Sign-in needed. Connect with /login meta.");
  });

  it("blocks a model whose saved sign-in failed", () => {
    const menu = buildMenu({
      readiness: {
        "xai/grok-4.5": { availability: false, unavailableReason: "auth-failed" },
      },
      loginProviders: ["xai"],
    });
    const block = resolveModelSelectionAuthBlock({ menu, provider: "xai", model: "grok-4.5" });
    expect(block?.notice).toBe("xai: Sign-in failed. Sign in again with /login xai.");
  });

  it("gives API-key entry instructions for key-only providers", () => {
    const menu = buildMenu({
      readiness: {
        "opencode-go/kimi-k2.5": { availability: false, unavailableReason: "missing-auth" },
      },
      loginProviders: ["opencode-go"],
      providerLogins: {
        "opencode-go": { methodId: "api-key", label: "OpenCode Go catalog" },
      },
    });
    const block = resolveModelSelectionAuthBlock({
      menu,
      provider: "opencode-go",
      model: "kimi-k2.5",
    });
    expect(block?.notice).toContain("API key");
    expect(block?.notice).toContain("Control UI → Models → Connect provider");
    expect(block?.notice).toContain("`openclaw models auth login --provider opencode-go`");
    expect(block?.notice).not.toContain("/login");
  });

  it("gives API-key update instructions when a saved key fails", () => {
    const menu = buildMenu({
      readiness: {
        "opencode-go/kimi-k2.5": { availability: false, unavailableReason: "auth-failed" },
      },
      loginProviders: ["opencode-go"],
      providerLogins: {
        "opencode-go": { methodId: "api-key", label: "OpenCode Go catalog" },
      },
    });
    const block = resolveModelSelectionAuthBlock({
      menu,
      provider: "opencode-go",
      model: "kimi-k2.5",
    });
    expect(block?.notice).toContain("Sign-in failed");
    expect(block?.notice).toContain("API key");
    expect(block?.notice).toContain("`openclaw models auth login --provider opencode-go`");
  });

  it("points custom providers without a login route at the setup guide", () => {
    const menu = buildMenu({
      readiness: {
        "custom-route/chat": { availability: false, unavailableReason: "missing-auth" },
      },
    });
    const block = resolveModelSelectionAuthBlock({
      menu,
      provider: "custom-route",
      model: "chat",
    });
    expect(block?.notice).toContain("custom-provider guide");
  });

  it.each([
    ["available", { availability: true } satisfies ModelReadiness],
    ["cooldown", { availability: false, unavailableReason: "cooldown" } satisfies ModelReadiness],
    ["unconfirmed", { availability: undefined } satisfies ModelReadiness],
  ])("does not block %s models", (_name, readiness) => {
    const menu = buildMenu({ readiness: { "meta/muse-spark-1.3": readiness } });
    expect(
      resolveModelSelectionAuthBlock({ menu, provider: "meta", model: "muse-spark-1.3" }),
    ).toBeUndefined();
  });

  it("blocks a never-signed-in provider (unconfirmed availability, reasoned missing-auth)", () => {
    // availability: undefined + a missing-auth reason is only produced when no
    // credential evidence exists at all; unprobed/local evaluations carry no
    // reason, so this is the never-configured case and must block.
    const menu = buildMenu({
      readiness: {
        "meta/muse-spark-1.3": { availability: undefined, unavailableReason: "missing-auth" },
      },
      loginProviders: ["meta"],
    });
    const block = resolveModelSelectionAuthBlock({
      menu,
      provider: "meta",
      model: "muse-spark-1.3",
    });
    expect(block?.label).toBe("Sign-in needed");
    expect(block?.loginSupported).toBe(true);
  });

  it("does not block an unobserved native-runtime model", () => {
    const menu = buildMenu({
      readiness: {
        "meta/muse-spark-1.3": {
          availability: undefined,
          unavailableReason: "missing-auth",
          runtimeAuth: { id: "muse", source: "native" },
        },
      },
      loginProviders: ["meta"],
    });
    expect(
      resolveModelSelectionAuthBlock({ menu, provider: "meta", model: "muse-spark-1.3" }),
    ).toBeUndefined();
  });

  it("marks blocks without a login route as not button-offerable", () => {
    const menu = buildMenu({
      readiness: {
        "custom-route/chat": { availability: false, unavailableReason: "missing-auth" },
      },
    });
    const block = resolveModelSelectionAuthBlock({
      menu,
      provider: "custom-route",
      model: "chat",
    });
    expect(block?.loginSupported).toBe(false);
  });

  it("does not block when readiness is unknown", () => {
    const menu = buildMenu({ readiness: { "meta/muse-spark-1.3": { availability: true } } });
    expect(
      resolveModelSelectionAuthBlock({ menu, provider: "meta", model: "other" }),
    ).toBeUndefined();
    expect(
      resolveModelSelectionAuthBlock({ provider: "meta", model: "muse-spark-1.3" }),
    ).toBeUndefined();
  });
});
