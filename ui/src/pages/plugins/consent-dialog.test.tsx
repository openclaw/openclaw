/* @vitest-environment jsdom */

import { flush, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { i18n } from "../../i18n/index.ts";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import {
  PluginArtTile,
  renderPluginConsentDialog as PluginConsentDialog,
} from "./consent-dialog.tsx";
import { createInspectResult } from "./plugins-page.test-support.ts";

type ConsentProps = Parameters<typeof PluginConsentDialog>[0];

function mount(overrides: Partial<ConsentProps> = {}): HTMLElement {
  const props: ConsentProps = {
    consent: {
      intent: { kind: "enable", pluginId: "workboard", rowKey: "plugin:workboard" },
      pluginId: "workboard",
      fallback: { name: "Workboard" },
    },
    inspection: createInspectResult(),
    inspectionRead: null,
    loading: false,
    error: null,
    canMutate: true,
    mutationBlockedReason: null,
    busy: false,
    onCancel: () => undefined,
    onConfirm: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  };
  const view = mountSolid(() => <PluginConsentDialog {...props} />);
  flush();
  return view.container;
}

function normalizedText(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

describe("renderPluginConsentDialog", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    cleanupSolid();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it.each([
    {
      source: {
        kind: "clawhub",
        packageName: "@openclaw/calendar-plus",
        integrity: "sha256-0123456789abcdefghijklmnop",
        integrityKind: "ssri",
      },
      meta: "Global · ClawHub · @openclaw/calendar-plus",
      provenance: ["Integrity: sha256-0123456789abc…"],
    },
    {
      source: {
        kind: "git",
        spec: "https://***:***@example.com/calendar.git?token=***#main",
        packageName: "@openclaw/calendar-plus",
        integrity: "0123456789abcdef0123456789abcdef01234567",
        integrityKind: "git-commit",
      },
      meta: "Global · Git · @openclaw/calendar-plus",
      provenance: [
        "https://***:***@example.com/calendar.git?token=***#main",
        "Commit: 0123456789abcdef0123…",
      ],
    },
  ] as const)(
    "presents capabilities, grants, safe $source.kind provenance, and trust before enablement",
    ({ source, meta, provenance }) => {
      const inspection = createInspectResult({
        plugin: {
          id: "calendar-runtime",
          name: "Calendar Plus",
          version: "2.0.0",
          origin: "global",
          installed: true,
          enabled: false,
        },
        source,
        declared: {
          channels: ["calendar-channel"],
          providers: ["calendar-provider"],
          tools: ["calendar_create"],
          contracts: ["gatewayMethodDispatch: calendar.dispatch"],
          hooks: ["before_prompt_build"],
          mcpServers: ["calendar-mcp"],
          cliCommands: ["calendar"],
          cliBackends: ["calendar-cli"],
          skills: ["schedule"],
          dangerousConfigFlags: ["calendar.allowShell"],
        },
        grants: {
          hooks: {
            allowPromptInjection: { effective: false, configured: false },
            allowConversationAccess: { effective: false },
          },
          llm: { allowedModels: ["model-a", "model-b"] },
          subagent: { allowModelOverride: true },
        },
        trust: {
          disposition: "review-required",
          reasons: ["Requests an elevated permission"],
          checkedAt: "2026-08-25",
        },
      });
      const onConfirm = vi.fn();
      const container = mount({
        consent: {
          intent: {
            kind: "enable",
            pluginId: "calendar-runtime",
            rowKey: "plugin:calendar-runtime",
          },
          pluginId: "calendar-runtime",
          fallback: { name: "Calendar Plus", version: "2.0.0" },
        },
        inspection,
        onConfirm,
      });

      const dialog = container.querySelector('[data-plugin-consent="enable"]');
      const text = normalizedText(dialog);
      const header = dialog?.querySelector(".plugins-consent__identity");
      expect(normalizedText(header?.querySelector("h2") ?? null)).toBe("Calendar Plus");
      expect(normalizedText(header?.querySelector(".plugins-version") ?? null)).toBe("v2.0.0");
      expect(normalizedText(header?.querySelector("p") ?? null)).toBe(meta);
      expect(
        Array.from(dialog?.querySelectorAll(".plugins-consent__provenance > span") ?? [], (span) =>
          normalizedText(span),
        ),
      ).toEqual(provenance);
      expect(text.split("@openclaw/calendar-plus")).toHaveLength(2);
      for (const value of [
        "Review required",
        "Requests an elevated permission",
        "Scanned 2026-08-25",
        "calendar-channel",
        "calendar-provider",
        "calendar_create",
        "Contracts gatewayMethodDispatch: calendar.dispatch",
        "before_prompt_build",
        "calendar-mcp",
        "calendar-cli",
        "schedule",
        "Dangerous config flags calendar.allowShell",
        "Modify prompts",
        "Allows this plugin to add or change the context and instructions sent to the model, which can influence its responses. Only allow this for plugins you trust.",
        "Blocked (set in config)",
        "Conversation access Off (default)",
        "Off by default for external plugins.",
        "Allowed models: model-a, model-b",
        "Subagent model overrides Model override: Allowed",
        "Enable Calendar Plus",
      ]) {
        expect(text).toContain(value);
      }
      expect(dialog?.querySelector("[title]")?.getAttribute("title")).toBe(source.integrity);
      dialog?.querySelector<HTMLButtonElement>(".btn.primary")?.click();
      expect(onConfirm).toHaveBeenCalledOnce();
    },
  );

  it("explains an empty manifest and preserves external-plugin grants", () => {
    const container = mount();
    const text = normalizedText(container.querySelector('[data-plugin-consent="enable"]'));

    expect(text).toContain("No channels, providers, or tools declared in the manifest.");
    expect(text).toContain(
      "Code plugins may register hooks at runtime; their hook names are not declared in the manifest.",
    );
    expect(text).toContain("Your grants");
    expect(text).toContain("Enable Workboard");
    expect(text).not.toContain("What changed");
  });

  it("highlights newly declared capability groups since the previous acceptance", () => {
    const reviewToken = "a".repeat(64);
    const inspection = createInspectResult({
      reviewToken,
      declared: {
        ...createInspectResult().declared,
        tools: ["workboard_review"],
        contracts: ["gatewayMethodDispatch: workboard.dispatch"],
        providers: ["workboard-provider"],
        dangerousConfigFlags: ["workboard.allowShell"],
      },
    });
    const container = mount({
      consent: {
        intent: { kind: "enable", pluginId: "workboard", rowKey: "plugin:workboard" },
        pluginId: "workboard",
        fallback: { name: "Workboard" },
        details: buildCapabilityConsentErrorDetails({
          pluginId: "workboard",
          reviewToken,
          widened: {
            tools: ["workboard_review"],
            contracts: ["gatewayMethodDispatch: workboard.dispatch"],
            providers: ["workboard-provider"],
            dangerousConfigFlags: ["workboard.allowShell"],
          },
          acceptedAt: "2026-08-20T14:03:00Z",
        }),
      },
      inspection,
    });

    const dialog = container.querySelector('[data-plugin-consent="enable"]');
    const text = normalizedText(dialog);
    expect(text).toContain("What changed");
    expect(text).toContain("New since your last acceptance");
    expect(text).toContain("2026-08-20T14:03:00Z");
    expect(text).toContain("Tools workboard_review");
    expect(text).toContain("Contracts gatewayMethodDispatch: workboard.dispatch");
    expect(text).toContain("Model providers workboard-provider");
    expect(text).toContain("Dangerous config flags workboard.allowShell");
    expect(text.indexOf("What changed")).toBeLessThan(text.indexOf("Declared capabilities"));
    expect(dialog?.querySelectorAll(".plugins-consent__row--warning")).toHaveLength(5);
  });

  it("prevents approval until the package capabilities have been inspected", () => {
    const container = mount({
      consent: {
        intent: {
          kind: "enable",
          pluginId: "community-calendar",
          rowKey: "plugin:community-calendar",
        },
        pluginId: "community-calendar",
        fallback: {
          name: "Community Calendar",
          version: "1.2.0",
          official: false,
        },
      },
      inspection: null,
    });

    const dialog = container.querySelector('[data-plugin-consent="enable"]');
    expect(normalizedText(dialog)).toContain("Community Calendar");
    expect(normalizedText(dialog)).toContain(
      "Capability details must be available before you can approve this plugin.",
    );
    expect(dialog?.querySelector<HTMLButtonElement>(".btn.primary")?.disabled).toBe(true);
  });

  it("keeps blocked consent confirmation reachable without dispatching it", async () => {
    const onConfirm = vi.fn();
    const container = mount({
      canMutate: false,
      mutationBlockedReason: "Admin access required.",
      onConfirm,
    });
    const confirm = container.querySelector<HTMLButtonElement>(".btn.primary");

    expect(confirm?.disabled).toBe(false);
    expect(confirm?.getAttribute("aria-disabled")).toBe("true");
    const tooltip = confirm?.closest("openclaw-tooltip") as
      | (HTMLElement & { content?: string; updateComplete: Promise<unknown> })
      | null;
    await tooltip?.updateComplete;
    expect(tooltip?.content).toBe("Admin access required.");
    expect(confirm?.getAttribute("aria-describedby")).toBeTruthy();
    confirm?.focus();
    expect(document.activeElement).toBe(confirm);
    confirm?.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

it("tries the author image after a broken package image, then retains initials until the source changes", () => {
  const [url, setUrl] = createSignal("blob:package");
  const unregister = vi.fn();
  const onIconError = vi.fn();
  const view = mountSolid(() => (
    <PluginArtTile
      slug="lossless-claw"
      name="Lossless Context Management"
      iconUrl={url()}
      authorIconUrl="blob:author"
      registerIcon={() => unregister}
      onIconError={onIconError}
    />
  ));
  const container = view.container;
  flush();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:package");
  container.querySelector("img")!.dispatchEvent(new Event("error"));
  flush();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:author");
  container.querySelector("img")!.dispatchEvent(new Event("error"));
  flush();
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent?.trim()).toBe("LC");
  setUrl("blob:package");
  flush();
  expect(container.querySelector("img")).toBeNull();
  setUrl("blob:updated");
  flush();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:updated");
  const detachedImage = container.querySelector("img")!;
  view.unmount();
  detachedImage.dispatchEvent(new Event("error"));
  expect(onIconError).toHaveBeenCalledTimes(1);
  expect(unregister).toHaveBeenCalledOnce();
});
