import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProviderAuthChoices } from "./manifest-setup-normalizers.js";
import type { ProviderAuthChoiceMetadata } from "./provider-auth-choices.js";
import {
  listProviderLoginOptions,
  resolveProviderChannelLoginChoice,
} from "./provider-login-options.js";

const declarations = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestDeclaredProviderAuthChoices: declarations.read,
}));

function choice(overrides: Partial<ProviderAuthChoiceMetadata> = {}): ProviderAuthChoiceMetadata {
  return {
    pluginId: "demo",
    providerId: "demo",
    methodId: "device-code",
    choiceId: "demo-device",
    choiceLabel: "Demo Device",
    groupId: "demo",
    groupLabel: "Demo",
    appGuidedAuth: "device-code",
    credentialOnly: true,
    channelLogin: {},
    ...overrides,
  };
}

describe("provider login choices", () => {
  beforeEach(() => declarations.read.mockReturnValue([]));

  it("keeps undeclared credential-only support on setup and filters hidden or media choices", () => {
    const choices = [
      choice(),
      choice({ choiceId: "setup", credentialOnly: undefined }),
      choice({ choiceId: "hidden", assistantVisibility: "manual-only" }),
      choice({ choiceId: "media", onboardingScopes: ["image-generation"] }),
    ];
    expect(listProviderLoginOptions(choices).map((option) => option.id)).toEqual([
      "demo/demo-device",
    ]);
  });

  it("keeps a single provider behind an explicit menu selection", () => {
    declarations.read.mockReturnValue([choice()]);
    expect(resolveProviderChannelLoginChoice(undefined)).toEqual({
      status: "providers",
      providers: [{ pluginId: "demo", providerId: "demo", label: "Demo" }],
    });
  });

  it("lists provider families once even when login requires setup", () => {
    declarations.read.mockReturnValue([
      choice(),
      choice({ choiceId: "browser", methodId: "oauth" }),
      choice({ choiceId: "api-key", appGuidedAuth: undefined, appGuidedSecret: true }),
      choice({
        pluginId: "setup",
        providerId: "setup",
        groupId: "setup",
        groupLabel: "Setup",
        credentialOnly: undefined,
      }),
    ]);
    expect(resolveProviderChannelLoginChoice(undefined)).toEqual({
      status: "providers",
      providers: [
        { pluginId: "demo", providerId: "demo", label: "Demo" },
        { pluginId: "setup", providerId: "setup", label: "Setup" },
      ],
    });
    expect(resolveProviderChannelLoginChoice("oauth/demo/demo")).toMatchObject({
      status: "ambiguous",
      choices: [{ choiceId: "demo-device" }, { choiceId: "browser" }],
    });
  });

  it("shows cloud and server choices when a family name is also a choice id", () => {
    declarations.read.mockReturnValue([
      choice({
        choiceId: "demo",
        appGuidedAuth: undefined,
        appGuidedDiscovery: true,
        credentialOnly: undefined,
      }),
      choice({
        choiceId: "demo-cloud",
        providerId: "demo-cloud",
        appGuidedAuth: undefined,
        appGuidedSecret: true,
      }),
    ]);
    expect(resolveProviderChannelLoginChoice("demo")).toMatchObject({
      status: "ambiguous",
      choices: [
        { choiceId: "demo", mode: "setup" },
        { choiceId: "demo-cloud", mode: "secret" },
      ],
    });
    expect(resolveProviderChannelLoginChoice("oauth/demo/demo").status).toBe("unsupported");
  });

  it("binds a qualified method to its owner and never falls back from a stale reference", () => {
    declarations.read.mockReturnValue([
      choice(),
      choice({ pluginId: "other", channelLogin: { aliases: ["gone/demo-device"] } }),
    ]);
    expect(resolveProviderChannelLoginChoice("demo/demo-device")).toMatchObject({
      status: "resolved",
      choice: { pluginId: "demo", methodId: "device-code", command: "demo/demo-device" },
    });
    expect(resolveProviderChannelLoginChoice("gone/demo-device")).toMatchObject({
      status: "unsupported",
    });
    expect(resolveProviderChannelLoginChoice("DEMO/demo-device")).toMatchObject({
      status: "unsupported",
    });
    expect(resolveProviderChannelLoginChoice("demo-device")).toMatchObject({ status: "ambiguous" });
  });

  it("offers aliases only for a declared fixed-input method and keeps unsupported chat on handoff", () => {
    declarations.read.mockReturnValue([choice({ channelLogin: { aliases: ["pair"] } })]);
    expect(resolveProviderChannelLoginChoice("pair")).toMatchObject({
      status: "resolved",
      choice: { mode: "chat" },
    });
    declarations.read.mockReturnValue([choice({ credentialOnly: undefined })]);
    expect(resolveProviderChannelLoginChoice("demo/demo-device")).toMatchObject({
      status: "resolved",
      choice: { mode: "setup" },
    });
  });

  it("normalizes valid chat declarations without enabling malformed ones", () => {
    const base = { provider: "demo", method: "device-code", choiceId: "demo-device" };
    expect(
      normalizeProviderAuthChoices([
        { ...base, credentialOnly: true, channelLogin: { aliases: [" pair ", "pair"] } },
      ])?.[0],
    ).toMatchObject({
      credentialOnly: true,
      channelLogin: { aliases: ["pair"] },
    });
    for (const channelLogin of [{ aliases: [4] }, { aliases: [""] }, { unexpected: true }]) {
      expect(
        normalizeProviderAuthChoices([{ ...base, credentialOnly: "true", channelLogin }])?.[0],
      ).not.toHaveProperty("channelLogin");
    }
  });
});
