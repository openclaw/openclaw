import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { ToolsCatalogResult, ToolsEffectiveResult } from "../../api/types.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
import { cleanupSolid } from "../../test-helpers/solid-cleanup.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createBaseParams,
  createReadToolCatalog,
  openToolGroups,
} from "./panels-tools-skills.test-support.ts";
import { AgentTools } from "./panels-tools-skills.tsx";

installBrowserHistoryIsolation();
afterEach(cleanupSolid);

function mountTools(
  overrides: Parameters<typeof createBaseParams>[0] = {},
  container?: HTMLElement,
) {
  const view = mountSolid(AgentTools, createBaseParams(overrides), container);
  openToolGroups(view.container);
  return view;
}

const text = (element: Element | null | undefined) => element?.textContent?.trim();
const texts = (root: Element, selector: string) =>
  Array.from(root.querySelectorAll(selector), text);
const content = (root: Element, selector: string) => text(root.querySelector(selector));
type CatalogTool = ToolsCatalogResult["groups"][number]["tools"][number];
const catalogTool = (id: string, overrides: Partial<CatalogTool> = {}): CatalogTool => ({
  id,
  label: id,
  description: id,
  source: "core",
  defaultProfiles: [],
  ...overrides,
});
type PreviewTool = ToolsEffectiveResult["groups"][number]["tools"][number];
const previewTool = (id: string, overrides: Partial<PreviewTool> = {}): PreviewTool => ({
  id,
  label: id,
  description: id,
  rawDescription: id,
  source: "core",
  ...overrides,
});
const button = (root: Element, label: string) => {
  const control = Array.from(root.querySelectorAll("button")).find(
    (entry) => text(entry) === label,
  );
  assert(control, `Missing control: ${label}`);
  return control;
};
const toolSwitch = (root: Element, id: string) => {
  const card = Array.from(root.querySelectorAll(".agent-tool-card")).find(
    (entry) => content(entry, ".agent-tool-title") === id,
  );
  const control = card?.querySelector<HTMLInputElement>("input.settings-toggle__input");
  assert(control, `Missing tool switch: ${id}`);
  return control;
};

function policyCatalog(
  ids: string[],
  profile: ToolsCatalogResult["profiles"][number]["id"] = "full",
): ToolsCatalogResult {
  return {
    agentId: "main",
    profiles: [{ id: profile, label: profile === "full" ? "Full" : "Minimal" }],
    groups: [
      {
        id: "policy",
        label: "Policy",
        source: "core",
        tools: ids.map((id) => catalogTool(id)),
      },
    ],
  };
}

function pluginCatalog(optional: boolean): ToolsCatalogResult {
  return {
    agentId: "main",
    profiles: [{ id: "full", label: "Full" }],
    groups: [
      {
        id: "plugin:voice-call",
        label: "voice-call",
        source: "plugin",
        pluginId: "voice-call",
        tools: [
          catalogTool("voice_call", {
            source: optional ? "plugin" : (undefined as never),
            pluginId: optional ? "voice-call" : undefined,
            optional,
            defaultProfiles: optional ? [] : ["full"],
          }),
        ],
      },
    ],
  };
}

const toolPreview: ToolsEffectiveResult = {
  agentId: "main",
  profile: "full",
  groups: [
    {
      id: "core",
      label: "Built-in tools",
      source: "core",
      tools: [previewTool("read")],
    },
  ],
  notices: [{ id: "mcp-not-yet-listed", severity: "info", message: "Discovery is incomplete." }],
};

const toolFact = (root: Element | null | undefined, label: string) =>
  Array.from(root?.querySelectorAll(".agent-tool-details .settings-kv dt") ?? [])
    .find((term) => term.textContent?.trim() === label)
    ?.nextElementSibling?.textContent?.trim();

describe("agents tools panel (browser)", () => {
  it("updates preset and catalog labels when the mounted panel changes language", async () => {
    const restoreI18n = captureI18nStateForTesting();
    try {
      await i18n.setLocale("en");
      const { container } = mountTools({
        catalog: {
          agentId: "main",
          profiles: [{ id: "coding", label: "Coding" }],
          groups: [{ id: "media", label: "Media", source: "core", tools: [] }],
        },
      });
      const presetLabel = () => content(container, ".agent-tools-buttons button");
      const groupLabel = () => content(container, ".agent-tools-group__title");
      expect(presetLabel()).toBe("Coding");
      expect(groupLabel()).toBe("Media");

      await i18n.setLocale("de");
      await waitForSolid(() => {
        expect(presetLabel()).toBe("Programmierung");
        expect(groupLabel()).toBe("Medien");
      });
    } finally {
      await restoreI18n();
    }
  });

  it.each([
    { name: "not requested", overrides: {}, status: "Not loaded" },
    {
      name: "another agent",
      overrides: { runtimeSessionMatchesSelectedAgent: false, effective: toolPreview },
      status: "Other Agent",
    },
  ])("does not treat a $name preview as zero tools or denied access", ({ overrides, status }) => {
    const container = document.createElement("div");
    const params = createBaseParams(overrides);
    if (params.effective) {
      params.effective = {
        ...params.effective,
        toolAccess: {
          checked: "live-session",
          profiles: [],
          tools: [
            {
              id: "exec",
              status: "excluded",
              reasons: [{ kind: "profile", label: "Old profile exclusion" }],
            },
          ],
        },
      };
    }
    mountSolid(AgentTools, params, container);
    openToolGroups(container);

    expect(container.querySelectorAll(".settings-kv dd")[3]?.textContent?.trim()).toBe(status);
    expect(container.querySelector(".agent-tools-runtime-chip")).toBeNull();
    expect(container.querySelector(".agent-tools-notices")).toBeNull();
    const row = container.querySelector("#agent-tool-exec");
    expect(row?.textContent).not.toContain("Old profile exclusion");
    expect(row?.querySelector(".agent-tool-policy")).toBeNull();
    expect(toolFact(row, "Tool preview")).toBe(status);
  });

  it("distinguishes missing preview entries from disabled tools and an empty result", () => {
    const container = document.createElement("div");
    const params = createBaseParams({ effective: toolPreview });
    const view = mountSolid(AgentTools, params, container);
    openToolGroups(container);

    expect(content(container, ".agent-tools-notices .callout.info")).toBe(
      "Discovery is incomplete.",
    );

    const included = container.querySelector("#agent-tool-read");
    const absent = container.querySelector("#agent-tool-exec");
    expect(toolFact(included, "Tool preview")).toBe("Listed in preview via Built-In.");
    expect(included?.textContent).toContain("Listed in preview via Built-In.");
    expect(toolFact(absent, "Tool preview")).toBe("Not listed");
    expect(absent?.querySelector<HTMLInputElement>("input.settings-toggle__input")?.checked).toBe(
      true,
    );
    expect(container.querySelector(".agent-tools-group__counts")?.textContent).toMatch(
      /^\d+\/\d+$/,
    );

    view.update({
      ...params,
      effective: {
        ...toolPreview,
        groups: [{ id: "core", label: "Built-in tools", source: "core", tools: [] }],
      },
    });
    expect(container.querySelectorAll(".settings-kv dd")[3]?.textContent?.trim()).toBe("0");
    expect(container.textContent).toContain("No tools are listed in this preview.");
    expect(container.querySelector(".agent-tools-runtime-chip")).toBeNull();
  });

  it("renders catalog provenance and a prospective tool preview", async () => {
    const { container } = mountTools({
      catalog: {
        ...pluginCatalog(true),
        groups: [
          {
            id: "media",
            label: "Media",
            source: "core",
            tools: [catalogTool("tts")],
          },
          ...pluginCatalog(true).groups,
        ],
      },
      effective: {
        agentId: "main",
        profile: "messaging",
        groups: [
          previewTool("message", {
            label: "Message Actions",
            source: "channel",
            channelId: "guildchat",
          }),
          previewTool("reproProbe__probe_tool", {
            label: "Probe Tool",
            source: "mcp",
            pluginId: "bundle-mcp",
          }),
        ].map((tool) => ({
          id: tool.source,
          label: tool.source,
          source: tool.source,
          tools: [tool],
        })),
      },
    });

    expect(container.querySelectorAll(".settings-kv dd")[3]?.textContent?.trim()).toBe("2");
    expect(container.textContent).toContain(
      "Based on saved session settings and discovered tools.",
    );
    expect(container.textContent).toContain("additional tools may become available");
    expect(container.textContent).toContain("unsaved edits are not included");
    expect(texts(container, ".agent-tools-runtime-chip .mono")).toEqual([
      "Message Actions",
      "Probe Tool",
    ]);
    expect(texts(container, ".agent-tools-runtime-chip__meta")).toEqual([
      "Channel: guildchat",
      "MCP",
    ]);
    expect(texts(container, ".agent-tools-group__title > .settings-row__value")).toEqual([
      "Plugin: voice-call",
    ]);
    expect(toolFact(container.querySelector("#agent-tool-tts"), "Source")).toBe("Built-In");
    expect(toolFact(container.querySelector("#agent-tool-voice_call"), "Source")).toBe(
      "Plugin: voice-call · Optional",
    );
  });

  it("edits fallback tool access without selecting Full and can return to Inherit", async () => {
    const onOverridesChange = vi.fn();
    const onProfileChange = vi.fn();
    const { container } = mountTools({
      configForm: { agents: { entries: { main: { tools: { profile: "coding" } } } } },
      onOverridesChange,
      onProfileChange,
    });
    await Promise.resolve();

    expect(container.textContent).toContain(
      "Full selects tools; it does not grant Full access execution permissions.",
    );
    const toggle = toolSwitch(container, "openclaw");
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onOverridesChange).toHaveBeenCalledExactlyOnceWith("main", ["openclaw"], []);
    expect(onProfileChange).not.toHaveBeenCalled();
    button(container, "Inherit").click();
    expect(onProfileChange).toHaveBeenCalledExactlyOnceWith("main", null, false);
  });

  it("uses section-level plugin provenance for tool details", async () => {
    const { container } = mountTools({ catalog: pluginCatalog(false) });
    await Promise.resolve();

    const tool = container.querySelector<HTMLDetailsElement>(".agent-tool-card");
    tool!.open = true;

    expect(toolFact(tool, "Source")).toBe("Plugin: voice-call");
  });

  it.each([
    { reduced: true, behavior: "auto" },
    { reduced: false, behavior: "smooth" },
  ] as const)("opens a live tool chip with $behavior scrolling", async ({ reduced, behavior }) => {
    const container = document.createElement("div");
    document.body.append(container);
    mountSolid(
      AgentTools,
      createBaseParams({ catalog: createReadToolCatalog(), effective: toolPreview }),
      container,
    );
    await Promise.resolve();

    const group = container.querySelector<HTMLDetailsElement>(".agent-tools-group");
    expect(container.querySelector(".agent-tool-card")).toBeNull();
    const chip = container.querySelector<HTMLAnchorElement>(
      '.agent-tools-runtime-chip[href="#agent-tool-read"]',
    );

    expect(chip?.getAttribute("href")).toBe("#agent-tool-read");
    assert(group && chip, "Missing agent tool runtime chip");

    expect(group.open).toBe(false);
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: reduced }));
    const previousUrl = window.location.href;
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    try {
      chip.click();
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });

      const tool = container.querySelector<HTMLDetailsElement>(".agent-tool-card")!;
      const summary = tool.querySelector<HTMLElement>("summary")!;
      expect(group.open).toBe(true);
      expect(tool.open).toBe(true);
      expect(toolSwitch(container, "read").closest(".agent-tool-summary")).toBe(summary);
      expect(document.activeElement).toBe(summary);
      const requestedUrl = replaceState.mock.calls[0]?.[2];
      expect(requestedUrl).toBeInstanceOf(URL);
      expect((requestedUrl as URL).hash).toBe("#agent-tool-read");
      expect(window.location.href).toBe(previousUrl);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior });
      expect(scrollIntoView.mock.contexts[0]).toBe(tool);
      group.open = false;
      group.dispatchEvent(new Event("toggle"));
      expect(tool.open).toBe(false);
      await waitForSolid(() => expect(container.querySelector(".agent-tool-card")).toBeNull());
      group.querySelector<HTMLElement>(":scope > summary")!.click();
      await waitForSolid(() =>
        expect(container.querySelector<HTMLDetailsElement>(".agent-tool-card")?.open).toBe(false),
      );
    } finally {
      vi.unstubAllGlobals();
      scrollIntoView.mockRestore();
      replaceState.mockRestore();
      container.remove();
    }
  });

  it.each([
    {
      name: "enables one profile tool",
      tool: "session_status",
      enabled: true,
      expectedAllow: ["untouched", "exec", "web_*"],
      expectedDeny: ["read", "web_*"],
    },
    {
      name: "disables one aliased tool",
      tool: "bash",
      enabled: false,
      expectedAllow: ["untouched", "web_*"],
      expectedDeny: ["session_status", "read", "web_*", "exec"],
    },
    {
      name: "enables the catalog without removing wildcard denies",
      tool: null,
      enabled: true,
      expectedAllow: ["untouched", "exec", "web_*", "web_fetch"],
      expectedDeny: ["read", "web_*"],
    },
    {
      name: "disables the catalog without removing wildcard allows",
      tool: null,
      enabled: false,
      expectedAllow: ["untouched", "web_*"],
      expectedDeny: ["session_status", "read", "web_*", "exec", "web_fetch"],
    },
    {
      name: "publishes one normalized update for an empty catalog",
      tool: null,
      enabled: true,
      emptyCatalog: true,
      expectedAllow: ["untouched", "exec", "web_*"],
      expectedDeny: ["session_status", "read", "web_*"],
    },
  ])("$name with one immutable override update", async (testCase) => {
    const tools = {
      profile: "minimal",
      alsoAllow: [" untouched ", " BASH ", "exec", "", "web_*"],
      deny: [" SESSION_STATUS ", "read", "web_*", "", "read"],
    };
    const configForm = { agents: { entries: { main: { tools } } } };
    const originalConfig = structuredClone(configForm);
    const onOverridesChange = vi.fn();
    const toolIds = testCase.emptyCatalog ? [] : ["session_status", "bash", "web_fetch"];
    const { container } = mountTools({
      configForm,
      onOverridesChange,
      catalog: policyCatalog(toolIds, "minimal"),
    });
    await Promise.resolve();

    if (testCase.tool) {
      const toggle = toolSwitch(container, testCase.tool);
      expect(toggle.checked).toBe(!testCase.enabled);
      toggle.checked = testCase.enabled;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      button(container, testCase.enabled ? "Enable All" : "Disable All").click();
    }

    expect(onOverridesChange).toHaveBeenCalledExactlyOnceWith(
      "main",
      testCase.expectedAllow,
      testCase.expectedDeny,
    );
    expect(configForm).toEqual(originalConfig);
  });

  it.each([
    ["prefix wildcard", { allow: ["web_*"] }, { web_fetch: true, web_: true, read: false }],
    ["suffix wildcard", { allow: ["*fetch"] }, { web_fetch: true, read: false }],
    [
      "literal dots in wildcard",
      { allow: ["mcp.server.*"] },
      { "mcp.server.tool": true, mcpXserverXtool: false },
    ],
    [
      "base exec alias and direct deny",
      { allow: [" BASH "], deny: ["exec"] },
      { exec: false, apply_patch: false, write: false },
    ],
    [
      "override exec deny",
      { profile: "full", deny: ["exec"] },
      { exec: false, apply_patch: true, write: true },
    ],
    [
      "base write allow includes patching",
      { allow: ["write"] },
      { write: true, apply_patch: true, exec: false },
    ],
    [
      "override write allow includes patching",
      { profile: "minimal", alsoAllow: ["write"] },
      { write: true, apply_patch: true, exec: false },
    ],
    [
      "explicit patch deny wins over write allow",
      { profile: "minimal", alsoAllow: ["write"], deny: ["apply_patch"] },
      { write: true, apply_patch: false },
    ],
    [
      "group expansion and direct deny",
      { allow: ["group:fs"], deny: ["write"] },
      { read: true, write: false, apply_patch: true },
    ],
  ] as const)("renders policy-controlled switches: %s", async (_name, tools, expected) => {
    const { container } = mountTools({
      configForm: {
        agents: { entries: { main: { tools } } },
      },
      catalog: policyCatalog(Object.keys(expected), "full"),
    });
    await Promise.resolve();

    expect(
      Object.fromEntries(
        Array.from(container.querySelectorAll(".agent-tool-card"), (card) => [
          content(card, ".agent-tool-title"),
          card.querySelector<HTMLInputElement>("input.settings-toggle__input")?.checked,
        ]),
      ),
    ).toEqual(expected);
  });

  it("keeps tools in name order when a toggle or the preview changes", async () => {
    const params = createBaseParams({ catalog: policyCatalog(["zeta", "alpha", "mid"]) });
    const view = mountSolid(AgentTools, params);
    openToolGroups(view.container);
    const names = () => texts(view.container, ".agent-tool-title");
    const alphaSwitch = () =>
      view.container.querySelector<HTMLInputElement>(
        "#agent-tool-alpha input.settings-toggle__input",
      );
    expect(names()).toEqual(["alpha", "mid", "zeta"]);
    expect(alphaSwitch()?.checked).toBe(true);

    const preview: ToolsEffectiveResult = {
      ...toolPreview,
      groups: [{ ...toolPreview.groups[0]!, tools: [previewTool("zeta")] }],
    };
    view.update({
      ...params,
      configForm: {
        agents: { entries: { main: { tools: { profile: "full", deny: ["alpha"] } } } },
      },
      effective: preview,
      effectivePreview: preview,
    });

    await waitForSolid(() => expect(alphaSwitch()?.checked).toBe(false));
    expect(names()).toEqual(["alpha", "mid", "zeta"]);
  });
});
