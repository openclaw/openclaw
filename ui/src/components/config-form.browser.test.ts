import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { configHintTranslationKey } from "../i18n/lib/config-hint-translation.ts";
import { renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.ts";
import {
  analyzeConfigSchema,
  renderConfigForm as renderConfigFormBase,
  type JsonSchema,
} from "./config-form.ts";

function renderConfigForm(
  props: Omit<Parameters<typeof renderConfigFormBase>[0], "onShowAdvanced"> & {
    onShowAdvanced?: () => void;
  },
) {
  return renderConfigFormBase({ showAdvanced: true, onShowAdvanced: () => {}, ...props });
}

function object(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties };
}

const rootSchema = object({
  gateway: object({
    auth: object({
      token: { type: "string" },
    }),
  }),
  allowFrom: {
    type: "array",
    items: { type: "string" },
  },
  mode: {
    type: "string",
    enum: ["off", "token"],
  },
  enabled: {
    type: "boolean",
  },
  bind: {
    anyOf: [{ const: "auto" }, { const: "lan" }, { const: "tailnet" }, { const: "loopback" }],
  },
});
const rootAnalysis = analyzeConfigSchema(rootSchema);
let container: HTMLDivElement;
let onPatch: ReturnType<typeof vi.fn<Parameters<typeof renderConfigFormBase>[0]["onPatch"]>>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => container.remove());
  onPatch = vi.fn();
});

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

function selectSegmented(control: HTMLElement) {
  expectElement(
    control.querySelector<HTMLInputElement>('.settings-segmented__input[type="radio"]'),
    "segmented radio input",
  ).click();
}

afterEach(async () => {
  await i18n.setLocale("en");
});

describe("config form renderer", () => {
  it.each([
    {
      key: "gateway.auth.token",
      label: "Gateway Token",
      translated: "Ağ geçidi belirteci",
      help: "Token used to authenticate with the Gateway.",
      translatedHelp: "Ağ geçidi kimlik doğrulamasında kullanılan belirteç.",
      field: true,
    },
    {
      key: "cloudWorkers",
      label: "Cloud Workers",
      translated: "Bulut çalışanları",
      help: "Section help from the Gateway.",
      translatedHelp: "Bölüm açıklaması.",
      field: false,
    },
  ])(
    "localizes $key hints and preserves missing-copy fallbacks",
    async ({ key, label, translated, help, translatedHelp, field }) => {
      const hash = (kind: "label" | "help", text: string) =>
        configHintTranslationKey(key, kind, text).split(".").at(-1)!;
      i18n.registerTranslation("tr", {
        configHints: {
          [field ? "gateway%2Eauth%2Etoken" : key]: {
            label: { [hash("label", label)]: translated },
            help: { [hash("help", help)]: translatedHelp },
          },
        },
      });
      const analysis = field
        ? rootAnalysis
        : analyzeConfigSchema(
            object({
              [key]: {
                type: "object",
                description: "Schema description.",
                properties: { enabled: { type: "boolean" } },
              },
            }),
          );
      const props = { value: {}, onPatch, uiHints: { [key]: { label, help } } };
      const heading = () =>
        field
          ? container.querySelector("input.settings-input")?.getAttribute("aria-label")
          : container.querySelector("h2.settings-section__heading")?.textContent?.trim();
      const expectHelp = (text: string) => {
        if (field) {
          expect(container.textContent).toContain(text);
        } else {
          expect(container.querySelector(".settings-section__desc")?.textContent?.trim()).toBe(
            text,
          );
        }
      };
      for (const [locale, expectedLabel, expectedHelp] of [
        ["tr", translated, translatedHelp],
        ["en", label, help],
      ] as const) {
        await i18n.setLocale(locale);
        renderAnalyzedFormFixture(container, analysis, props);
        expect(heading()).toBe(expectedLabel);
        expectHelp(expectedHelp);
      }
      if (!field) {
        await i18n.setLocale("tr");
        renderAnalyzedFormFixture(container, analysis, {
          ...props,
          uiHints: { [key]: { label, help: "Updated Gateway help without a translation." } },
        });
        expect(heading()).toBe(translated);
        expectHelp("Updated Gateway help without a translation.");
        renderAnalyzedFormFixture(container, analysis, { ...props, uiHints: {} });
        expect(heading()).toBe("CloudWorkers");
        expectHelp("Schema description.");
      }
    },
  );

  it.each([false, true])(
    "renders section copy once, scoped to the subsection: %s",
    (subsection) => {
      renderAnalyzedFormFixture(container, rootAnalysis, {
        value: {},
        activeSection: "gateway",
        activeSubsection: subsection ? "auth" : undefined,
        uiHints: { gateway: { label: "Runtime gateway label", help: "Runtime gateway help" } },
        onPatch,
      });
      expect(
        Array.from(
          container.querySelectorAll(
            ".settings-section > .settings-section__header .settings-section__heading",
          ),
          (node) => node.textContent?.trim(),
        ),
      ).toEqual([subsection ? "Auth" : "Gateway"]);
      if (subsection) {
        expect(container.querySelector(".cfg-object")).toBeNull();
        expect(
          Array.from(container.querySelectorAll(".settings-row__title"), (node) =>
            node.textContent?.trim(),
          ),
        ).toEqual(["Token"]);
      } else {
        expect(container.querySelector(".settings-section__desc")?.textContent?.trim()).toBe(
          "Gateway server settings (port, auth, binding)",
        );
      }
    },
  );

  it("conceals core-classified encryption, private-key, and local service env values", () => {
    const analysis = analyzeConfigSchema(
      object({
        encryptKey: { type: "string" },
        privateKey: { type: "string" },
        localService: object({
          env: object({ FOO: { type: "string" } }),
        }),
      }),
    );

    renderAnalyzedFormFixture(container, analysis, {
      value: {
        encryptKey: "encrypt-value",
        privateKey: "private-value",
        localService: { env: { FOO: "env-value" } },
      },
      revealSensitive: false,
      onPatch,
    });

    for (const label of ["Encrypt Key", "Private Key", "FOO"]) {
      const input = expectElement(
        container.querySelector<HTMLInputElement>(`input[aria-label='${label}']`),
        `${label} input`,
      );
      expect(input.readOnly).toBe(true);
      expect(input.classList.contains("cfg-redacted")).toBe(true);
      expect(input.value).toBe("");
    }
    expect(container.innerHTML).not.toContain("encrypt-value");
    expect(container.innerHTML).not.toContain("private-value");
    expect(container.innerHTML).not.toContain("env-value");
  });

  it.each([
    ["string", { type: "string" }],
    ["string or SecretRef", { type: ["string", "object"] }],
  ])("keeps a masked sensitive %s field editable across keystrokes", async (_name, tokenSchema) => {
    const { userEvent } = await import("vitest/browser");
    const analysis = analyzeConfigSchema(object({ token: tokenSchema }));
    const revealed = new Set<string>();
    let value: Record<string, unknown> = {};
    const draw = () =>
      render(
        renderConfigForm({
          schema: analysis.schema,
          unsupportedPaths: analysis.unsupportedPaths,
          uiHints: { token: { sensitive: true } },
          value,
          maskSensitive: true,
          isSensitivePathRevealed: (path) => revealed.has(path.join(".")),
          onToggleSensitivePath: (path) => {
            revealed.add(path.join("."));
            draw();
          },
          onPatch: (_path, next) => {
            value = { token: next };
            draw();
          },
        }),
        container,
      );
    const token = () =>
      expectElement(
        container.querySelector<HTMLInputElement>("input[aria-label='Token']"),
        "token",
      );

    draw();
    await userEvent.click(token());
    await userEvent.keyboard("xy");
    await userEvent.click(token());

    expect(value).toEqual({ token: "xy" });
    expect(document.activeElement).toBe(token());
    expect(token().readOnly).toBe(false);
    expect(token().type).toBe("password");
    expect(revealed.size).toBe(0);
  });

  it("renders inputs and patches values", () => {
    const analysis = rootAnalysis;
    renderAnalyzedFormFixture(container, analysis, {
      uiHints: {
        "gateway.auth.token": { label: "Gateway Token", sensitive: true },
      },
      value: { allowFrom: ["+1"], bind: "auto" },
      revealSensitive: true,
      onPatch,
    });

    const tokenInput = expectElement(
      container.querySelector<HTMLInputElement>(
        '#config-section-gateway input.settings-input[type="text"]',
      ),
      "gateway token input",
    );
    tokenInput.value = "abc123";
    tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["gateway", "auth", "token"], "abc123");

    const tokenButton = expectElement(
      Array.from(container.querySelectorAll<HTMLElement>(".settings-segmented__btn")).find(
        (btn) => btn.textContent?.trim() === "token",
      ),
      "token segmented button",
    );
    selectSegmented(tokenButton);
    expect(onPatch).toHaveBeenCalledWith(["mode"], "token");

    const checkbox = expectElement(
      container.querySelector<HTMLInputElement>('.settings-toggle__input[role="switch"]'),
      "enabled switch",
    );
    checkbox.click();
    expect(onPatch).toHaveBeenCalledWith(["enabled"], true);

    const addButton = expectElement(
      Array.from(container.querySelectorAll<HTMLButtonElement>(".cfg-array button")).find(
        (btn) => btn.textContent?.trim() === "Add",
      ),
      "array add button",
    );
    addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], ["+1", ""]);

    const removeButton = expectElement(
      container.querySelector(".cfg-array button[aria-label='Remove item']"),
      "array remove button",
    );
    removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], []);

    const tailnetButton = expectElement(
      Array.from(container.querySelectorAll<HTMLElement>(".settings-segmented__btn")).find(
        (btn) => btn.textContent?.trim() === "tailnet",
      ),
      "tailnet segmented button",
    );
    selectSegmented(tailnetButton);
    expect(onPatch).toHaveBeenCalledWith(["bind"], "tailnet");
  });

  it("preserves raw phone values and focus as presentations change", () => {
    const analysis = analyzeConfigSchema(
      object({
        fromNumber: { type: "string" },
        target: { type: "string" },
        accounts: {
          type: "object",
          additionalProperties: object({
            allowFrom: {
              type: "array",
              items: { type: "string" },
            },
          }),
        },
      }),
    );
    const draw = (fromNumber: string) =>
      renderAnalyzedFormFixture(container, analysis, {
        uiHints: {
          fromNumber: { presentation: "phone-number" },
          target: { presentation: "phone-number" },
          "accounts.*.allowFrom.*": { presentation: "phone-number" },
        },
        value: {
          fromNumber,
          target: "token-value",
          accounts: { work: { allowFrom: ["+81312345678"] } },
        },
        onPatch,
      });

    draw("+4930123456");
    const phoneInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>(".settings-phone-presentation input"),
    );
    expect(phoneInputs.map((input) => input.value)).toEqual(
      expect.arrayContaining(["+4930123456", "+81312345678", "token-value"]),
    );
    expect(phoneInputs).toHaveLength(3);
    expect(
      Array.from(container.querySelectorAll(".settings-phone-presentation__value")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(expect.arrayContaining(["Germany · +49 30 123456", "Japan · +81 3 1234 5678"]));
    const tokenInput = expectElement(
      Array.from(container.querySelectorAll<HTMLInputElement>("input.settings-input")).find(
        (input) => input.value === "token-value",
      ),
      "token input",
    );
    const tokenPresentation = expectElement(
      tokenInput.closest(".settings-phone-presentation"),
      "token phone presentation wrapper",
    );
    expect(tokenPresentation.querySelector(".settings-phone-presentation__value")).toBeNull();

    const fromNumberInput = expectElement(
      phoneInputs.find((input) => input.value === "+4930123456"),
      "from number input",
    );
    fromNumberInput.value = " +4930123456 ";
    fromNumberInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["fromNumber"], " +4930123456 ");
    fromNumberInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["fromNumber"], "+4930123456");
    draw("+123");
    fromNumberInput.focus();
    for (const phone of ["+4930123456", "+123"]) {
      draw(phone);
      const presentation = fromNumberInput.closest(".settings-phone-presentation")!;
      if (phone === "+123") {
        expect(presentation.querySelector(".settings-phone-presentation__value")).toBeNull();
      } else {
        expect(
          presentation.querySelector(".settings-phone-presentation__value")?.textContent,
        ).toContain("+49 30 123456");
      }
      expect(presentation.querySelector("input.settings-input")).toBe(fromNumberInput);
      expect(document.activeElement).toBe(fromNumberInput);
    }
  });

  it.each([false, true])("renders named toggle rows with wildcard hints: %s", (wildcard) => {
    const analysis = analyzeConfigSchema(
      wildcard
        ? object({
            plugins: object({
              entries: {
                type: "object",
                additionalProperties: object({ enabled: { type: "boolean" } }),
              },
            }),
          })
        : object({
            features: object({ beta: { type: "boolean", description: "Enable beta features" } }),
          }),
    );
    renderAnalyzedFormFixture(container, analysis, {
      uiHints: wildcard ? { "plugins.entries.*.enabled": { label: "Plugin Enabled" } } : {},
      value: wildcard
        ? { plugins: { entries: { "voice-call": { enabled: true } } } }
        : { features: { beta: false } },
      onPatch,
    });
    const checkbox = expectElement(
      container.querySelector<HTMLInputElement>('.settings-toggle__input[role="switch"]'),
      "named toggle",
    );
    const row = expectElement(checkbox.closest(".settings-row"), "toggle row");
    const label = wildcard ? "Plugin Enabled" : "Beta";
    expect(row.tagName).toBe("DIV");
    expect(row.querySelector(".settings-row__title")?.textContent?.trim()).toBe(label);
    expect(
      container.querySelector(`#${checkbox.getAttribute("aria-labelledby")}`)?.textContent?.trim(),
    ).toBe(label);
    if (!wildcard) {
      expect(row.querySelector(".settings-row__desc")?.textContent?.trim()).toBe(
        "Enable beta features",
      );
    }
    checkbox.click();
    expect(onPatch).toHaveBeenCalledWith(
      wildcard ? ["plugins", "entries", "voice-call", "enabled"] : ["features", "beta"],
      !wildcard,
    );
  });

  it("keeps dropdown selects on their configured value after options render", () => {
    const schema = object({
      provider: {
        type: "string",
        enum: ["anthropic", "codex", "gemini", "openai", "openrouter", "zai"],
      },
      bind: {
        anyOf: [
          { const: "auto" },
          { const: "lan" },
          { const: "tailnet" },
          { const: "loopback" },
          { const: "public" },
          { const: "off" },
        ],
      },
    });
    const analysis = analyzeConfigSchema(schema);

    renderAnalyzedFormFixture(container, analysis, {
      value: { provider: "openai", bind: "tailnet" },
      onPatch,
    });

    const selects = container.querySelectorAll<HTMLSelectElement>("select.settings-select");
    expect(selects).toHaveLength(2);
    const selectedLabels = Array.from(selects).map((select) =>
      select.selectedOptions[0]?.textContent?.trim(),
    );
    expect(selectedLabels).toEqual(["tailnet", "openai"]);
  });

  it("shows an unset default-on boolean as its placeholder instead of an off toggle", () => {
    const analysis = analyzeConfigSchema(
      object({
        cron: object({ enabled: { type: "boolean" } }),
      }),
    );
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: { "cron.enabled": { label: "Automations Enabled", placeholder: "Default: On" } },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        onPatch,
      }),
      container,
    );

    expect(container.querySelector('.settings-toggle__input[role="switch"]')).toBeNull();
    const select = expectElement(
      container.querySelector<HTMLSelectElement>('select[aria-label="Automations Enabled"]'),
      "automations enabled select",
    );
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe("Default: On");
    expect(onPatch).not.toHaveBeenCalled();
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenLastCalledWith(["cron", "enabled"], false);
    select.value = "0";
    select.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenLastCalledWith(["cron", "enabled"], true);
    select.value = "__unset__";
    select.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenLastCalledWith(["cron", "enabled"], undefined);
  });

  it.each([
    { key: "slack", additionalProperties: { type: "string" }, value: { channelA: "ok" } },
    { key: "accounts", additionalProperties: true, value: { default: { enabled: true } } },
  ])("removes entries from the $key map", ({ key, additionalProperties, value }) => {
    const analysis = analyzeConfigSchema(
      object({ [key]: { type: "object", additionalProperties } }),
    );
    expect(analysis.unsupportedPaths).toEqual([]);
    renderAnalyzedFormFixture(container, analysis, { value: { [key]: value }, onPatch });
    expectElement(
      container.querySelector(".cfg-map button[aria-label='Remove entry']"),
      "map remove button",
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith([key], {});
  });

  it("filters by authored metadata tags without rendering field chips", () => {
    const analysis = rootAnalysis;
    renderAnalyzedFormFixture(container, analysis, {
      uiHints: {
        "gateway.auth.token": { tags: ["security", "advanced", "secret"] },
      },
      value: {},
      onPatch,
    });

    expect(container.querySelector(".cfg-tag")).toBeNull();

    renderAnalyzedFormFixture(container, analysis, {
      uiHints: {
        "gateway.auth.token": { tags: ["security", "advanced"] },
      },
      value: {},
      searchQuery: "tag:advanced",
      onPatch,
    });

    const sectionTitle = expectElement(
      container.querySelector(".settings-section__heading"),
      "tag-filtered section title",
    );
    expect(sectionTitle.textContent?.trim()).toBe("Gateway");
    const fieldLabel = expectElement(
      Array.from(container.querySelectorAll(".settings-row__title")).find(
        (node) => node.textContent?.trim() === "Token",
      ),
      "tag-filtered field label",
    );
    expect(fieldLabel.textContent?.trim()).toBe("Token");
    // Only the Auth subtree (matching the tag filter) renders rows.
    expect(
      Array.from(container.querySelectorAll(".settings-row__title")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Auth", "Token"]);
  });

  it("supports SecretInput unions in additionalProperties maps", () => {
    const schema = object({
      models: object({
        providers: {
          type: "object",
          additionalProperties: object({
            apiKey: {
              anyOf: [
                { type: "string" },
                {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        source: { type: "string", const: "env" },
                        provider: { type: "string" },
                        id: { type: "string" },
                      },
                      required: ["source", "provider", "id"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        source: { type: "string", const: "file" },
                        provider: { type: "string" },
                        id: { type: "string" },
                      },
                      required: ["source", "provider", "id"],
                      additionalProperties: false,
                    },
                  ],
                },
              ],
            },
          }),
        },
      }),
    });
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).toEqual([]);

    renderAnalyzedFormFixture(container, analysis, {
      uiHints: {
        "models.providers.*.apiKey": { sensitive: true },
      },
      value: { models: { providers: { openai: { apiKey: "old" } } } }, // pragma: allowlist secret
      revealSensitive: true,
      onPatch,
    });

    const apiKeyInput = expectElement(
      Array.from(
        container.querySelectorAll<HTMLInputElement>(
          "#config-section-models .cfg-map input.settings-input[type='text']",
        ),
      ).find((input) => input.value === "old"),
      "provider api key input",
    );
    apiKeyInput.value = "new-key";
    apiKeyInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["models", "providers", "openai", "apiKey"], "new-key");
  });

  it.each([
    {
      properties: { mixed: { anyOf: [{ type: "string" }, object({})] } },
      unsupported: [],
    },
    {
      properties: {
        lastTouchedAt: {
          title: "Config Last Touched At",
          description: "ISO timestamp of the last config write.",
          anyOf: [{ type: "string" }, {}],
        },
      },
      unsupported: ["lastTouchedAt"],
    },
    {
      properties: { note: { anyOf: [{ type: "string", nullable: true }] } },
      unsupported: [],
      nullable: true,
    },
    { properties: { note: { type: ["string", "null"] } }, unsupported: [] },
    {
      properties: {
        channels: {
          type: "object",
          properties: {
            whatsapp: object({ enabled: { type: "boolean" } }),
          },
          additionalProperties: {},
        },
      },
      unsupported: [],
    },
    {
      properties: {
        lastTouchedAt: { anyOf: [{ type: "string" }, { type: "number" }] },
        setupCommand: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        allowedDomains: { type: "array", items: { type: "string" } },
        displayWidth: { type: "string" },
      },
      unsupported: [],
      value: {
        lastTouchedAt: "2026-05-05T00:00:00.000Z",
        setupCommand: "apt-get update",
        allowedDomains: ["example.com"],
        displayWidth: "960px",
      },
    },
  ])(
    "analyzes public union shapes: $properties",
    ({ properties, unsupported, nullable, value }) => {
      const analysis = analyzeConfigSchema({ type: "object", properties });
      expect(analysis.unsupportedPaths).toEqual(unsupported);
      if (nullable) {
        expect(analysis.schema?.properties?.note?.nullable).toBe(true);
      }
      if (value) {
        renderAnalyzedFormFixture(container, analysis, { value, onPatch });
        expect(container.textContent).not.toContain("Unsupported schema node");
      }
    },
  );

  it.each([
    {
      key: "allowFrom",
      items: { type: "string" },
      defaults: ["+15550000000"],
      value: ["+15550001111", "+15550002222"],
      help: "Sender ids allowed to reach the agent.",
    },
    {
      key: "groups",
      items: { type: "array", default: ["nested-default"], items: { type: "string" } },
      defaults: [["root-default"]],
      value: [["first"], ["second"]],
      help: "Group sender ids.",
    },
  ])("renders $key metadata only on the array header", ({ key, items, defaults, value, help }) => {
    const analysis = analyzeConfigSchema(
      object({ [key]: { type: "array", items, default: defaults } }),
    );
    renderAnalyzedFormFixture(container, analysis, {
      uiHints: { [key]: { help } },
      value: { [key]: value },
      onPatch,
    });
    const descriptions = Array.from(container.querySelectorAll(".settings-row__desc"), (node) =>
      node.textContent?.trim(),
    );
    expect(descriptions.filter((text) => text === help)).toHaveLength(1);
    expect(
      descriptions.filter((text) => text === `Default: ${JSON.stringify(defaults)}`),
    ).toHaveLength(1);
    expect(descriptions.some((text) => text?.includes("nested-default"))).toBe(false);
  });

  it.each([true, false])("renders section help only with a docs URL: %s", (hasDocs) => {
    renderAnalyzedFormFixture(container, rootAnalysis, {
      uiHints: hasDocs
        ? { gateway: { docsUrl: "https://docs.openclaw.ai/gateway/configuration" } }
        : {},
      value: {},
      activeSection: "gateway",
      onPatch,
    });

    if (!hasDocs) {
      expect(container.querySelector(".settings-section__help-button")).toBeNull();
      return;
    }
    const button = expectElement(
      container.querySelector<HTMLButtonElement>(".settings-section__help-button"),
      "section help button",
    );
    expect(button.getAttribute("aria-label")).toBe("Help for Gateway");
    expect(button.querySelector("svg")).not.toBeNull();
    const tooltip = expectElement(button.closest("openclaw-tooltip"), "section help tooltip");
    expect((tooltip as HTMLElement & { content: string }).content).toBe("Help for Gateway");
    const link = expectElement(
      container.querySelector<HTMLAnchorElement>(".settings-section__help-popover a"),
      "section guide link",
    );
    expect(link.textContent?.trim()).toBe("Learn more");
    expect(link.classList.contains("learn-more-link")).toBe(true);
    const popover = expectElement(link.closest("wa-popover"), "section help popover");
    expect(button.getAttribute("aria-controls")).toBe(popover.id);
    expect(link.getAttribute("href")).toBe("https://docs.openclaw.ai/gateway/configuration");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
