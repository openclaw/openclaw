import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { configHintTranslationKey } from "../i18n/lib/config-hint-translation.ts";
import {
  expectElement,
  renderAnalyzedFormFixture,
  renderConfigFormFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { analyzeConfigSchema } from "./config-form.analyze.ts";
import type { ConfigFormProps, JsonSchema } from "./config-form.shared.ts";

function object(
  properties: Record<string, JsonSchema>,
  metadata: Partial<JsonSchema> = {},
): JsonSchema {
  return { type: "object", properties, ...metadata };
}
function analyze(properties: Record<string, JsonSchema>) {
  return analyzeConfigSchema(object(properties));
}

const rootAnalysis = analyze({
  gateway: object({ auth: object({ token: { type: "string" } }) }),
  allowFrom: { type: "array", items: { type: "string" } },
});
let container: HTMLDivElement;
let onPatch: ReturnType<typeof vi.fn<ConfigFormProps["onPatch"]>>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => container.remove());
  onPatch = vi.fn();
});

function query<T extends Element>(
  selector: string,
  elementType: new () => T,
  root: Element = container,
): T {
  const element = expectElement(root.querySelector(selector), selector);
  if (!(element instanceof elementType)) {
    throw new Error(`unexpected element type for ${selector}`);
  }
  return element;
}
function all<T extends Element = HTMLElement>(selector: string, root: Element = container): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}
function texts(selector: string, root: Element = container) {
  return all(selector, root).map((node) => node.textContent?.trim());
}
function inputWithValue(value: string, selector = "input.settings-input") {
  return expectElement(
    all<HTMLInputElement>(selector).find((input) => input.value === value),
    value,
  );
}
function renderForm(
  analysis: ReturnType<typeof analyzeConfigSchema>,
  props: Partial<Parameters<typeof renderAnalyzedFormFixture>[2]> = {},
) {
  renderAnalyzedFormFixture(container, analysis, { value: {}, onPatch, ...props });
}
function renderRaw(props: Partial<ConfigFormProps> & Pick<ConfigFormProps, "schema">) {
  renderConfigFormFixture(container, {
    uiHints: {},
    value: {},
    onPatch,
    showAdvanced: true,
    onShowAdvanced: () => {},
    ...props,
  });
}
function edit(input: HTMLInputElement | HTMLSelectElement, value: string, type = "input") {
  input.value = value;
  input.dispatchEvent(new Event(type, { bubbles: type === "input" }));
}

afterEach(() => i18n.setLocale("en"));

describe("config form renderer", () => {
  it.each([
    { label: "Ingress", initiallyOpen: false },
    { label: "Portals", initiallyOpen: true },
  ])(
    "retains the manually toggled $label disclosure across a form update",
    async ({ label, initiallyOpen }) => {
      const props = {
        schema: object({
          gateway: object({
            portals: object(
              {
                ingress: object({ port: { type: "integer" } }, { title: "Ingress" }),
              },
              { title: "Portals" },
            ),
          }),
        }),
        value: { gateway: { portals: { ingress: { port: 443 } } } },
      };
      const findDisclosure = (name = label) =>
        all<HTMLDetailsElement>("details.cfg-object").find(
          (node) =>
            node.querySelector(":scope > summary .settings-row__title")?.textContent?.trim() ===
            name,
        );
      renderRaw(props);
      const disclosure = expectElement(findDisclosure(), label);
      expect(disclosure.open).toBe(initiallyOpen);
      expect(container.querySelector('input[type="number"]')).toBeNull();

      const ingress = expectElement(findDisclosure("Ingress"), "Ingress");
      query("summary", HTMLElement, ingress).click();
      await waitForSolid(() =>
        expect(container.querySelector('input[type="number"]')).not.toBeNull(),
      );
      const input = query('input[type="number"]', HTMLInputElement);
      expect(input.value).toBe("443");
      if (initiallyOpen) {
        query("summary", HTMLElement, disclosure).click();
      }
      expect(disclosure.open).toBe(!initiallyOpen);

      // Once opened, native disclosure toggles keep the actual editor and its draft.
      input.value = "9443";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      query("summary", HTMLElement, disclosure).click();
      await waitForSolid(() => expect(container.querySelector('input[type="number"]')).toBe(input));
      expect(input.value).toBe("9443");
      query("summary", HTMLElement, disclosure).click();
      await waitForSolid(() => expect(disclosure.open).toBe(!initiallyOpen));

      renderRaw({
        ...props,
        value: { gateway: { portals: { ingress: { port: 8443 } } } },
      });

      expect(findDisclosure()).toBe(disclosure);
      expect(container.querySelector('input[type="number"]')).toBe(input);
      expect(input.value).toBe("8443");
      expect(disclosure.open).toBe(!initiallyOpen);
    },
  );

  it.each([
    [
      "gateway.auth.token",
      "Gateway Token",
      "Ağ geçidi belirteci",
      "Token used to authenticate with the Gateway.",
      "Ağ geçidi kimlik doğrulamasında kullanılan belirteç.",
    ],
    [
      "cloudWorkers",
      "Cloud Workers",
      "Bulut çalışanları",
      "Section help from the Gateway.",
      "Bölüm açıklaması.",
    ],
  ])(
    "localizes %s hints and preserves missing-copy fallbacks",
    async (key, label, translated, help, translatedHelp) => {
      const field = key === "gateway.auth.token";
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
        : analyze({
            [key]: object({ enabled: { type: "boolean" } }, { description: "Schema description." }),
          });
      const props = { uiHints: { [key]: { label, help } } };
      const heading = () =>
        field
          ? container.querySelector("input.settings-input")?.getAttribute("aria-label")
          : container.querySelector("h2.settings-section__heading")?.textContent?.trim();
      const expectHelp = (text: string) => {
        if (field) {
          expect(container.textContent).toContain(text);
        } else {
          expect(texts(".settings-section__desc")[0]).toBe(text);
        }
      };
      for (const [locale, expectedLabel, expectedHelp] of [
        ["tr", translated, translatedHelp],
        ["en", label, help],
      ] as const) {
        await i18n.setLocale(locale);
        renderForm(analysis, props);
        expect(heading()).toBe(expectedLabel);
        expectHelp(expectedHelp);
      }
      if (!field) {
        await i18n.setLocale("tr");
        renderForm(analysis, {
          ...props,
          uiHints: { [key]: { label, help: "Updated Gateway help without a translation." } },
        });
        expect(heading()).toBe(translated);
        expectHelp("Updated Gateway help without a translation.");
        renderForm(analysis, { ...props, uiHints: {} });
        expect(heading()).toBe("CloudWorkers");
        expectHelp("Schema description.");
      }
    },
  );

  it.each([false, true])(
    "renders section copy once, scoped to the subsection: %s",
    (subsection) => {
      renderForm(rootAnalysis, {
        activeSection: "gateway",
        activeSubsection: subsection ? "auth" : undefined,
        uiHints: { gateway: { label: "Runtime gateway label", help: "Runtime gateway help" } },
      });
      expect(
        texts(".settings-section > .settings-section__header .settings-section__heading"),
      ).toEqual([subsection ? "Auth" : "Gateway"]);
      if (subsection) {
        expect(container.querySelector(".cfg-object")).toBeNull();
        expect(texts(".settings-row__title")).toEqual(["Token"]);
      } else {
        expect(container.querySelector(".settings-section__desc")?.textContent?.trim()).toBe(
          "Gateway server settings (port, auth, binding)",
        );
      }
    },
  );

  it("conceals core-classified encryption, private-key, and local service env values", () => {
    const analysis = analyze({
      encryptKey: { type: "string" },
      privateKey: { type: "string" },
      localService: object({ env: object({ FOO: { type: "string" } }) }),
    });

    renderForm(analysis, {
      value: {
        encryptKey: "encrypt-value",
        privateKey: "private-value",
        localService: { env: { FOO: "env-value" } },
      },
      revealSensitive: false,
    });

    for (const label of ["Encrypt Key", "Private Key", "FOO"]) {
      const input = query(`input[aria-label='${label}']`, HTMLInputElement);
      expect(input).toMatchObject({ readOnly: true, value: "" });
      expect(input.classList.contains("cfg-redacted")).toBe(true);
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
    const analysis = analyze({ token: tokenSchema });
    const revealed = new Set<string>();
    let value: Record<string, unknown> = {};
    const draw = () =>
      renderRaw({
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
      });
    const token = () => query("input[aria-label='Token']", HTMLInputElement);

    draw();
    await userEvent.click(token());
    await userEvent.keyboard("xy");
    await userEvent.click(token());

    expect(value).toEqual({ token: "xy" });
    expect(document.activeElement).toBe(token());
    expect(token()).toMatchObject({ readOnly: false, type: "password" });
    expect(revealed.size).toBe(0);
  });

  it("preserves raw phone values and focus as presentations change", () => {
    const analysis = analyze({
      fromNumber: { type: "string" },
      target: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: object({ allowFrom: { type: "array", items: { type: "string" } } }),
      },
    });
    const draw = (fromNumber: string) =>
      renderForm(analysis, {
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
      });

    draw("+4930123456");
    const phoneInputs = all<HTMLInputElement>(".settings-phone-presentation input");
    expect(phoneInputs.map((input) => input.value)).toEqual(
      expect.arrayContaining(["+4930123456", "+81312345678", "token-value"]),
    );
    expect(phoneInputs).toHaveLength(3);
    expect(texts(".settings-phone-presentation__value")).toEqual(
      expect.arrayContaining(["Germany · +49 30 123456", "Japan · +81 3 1234 5678"]),
    );
    const tokenInput = inputWithValue("token-value");
    const tokenPresentation = expectElement(
      tokenInput.closest(".settings-phone-presentation"),
      "token phone presentation wrapper",
    );
    expect(tokenPresentation.querySelector(".settings-phone-presentation__value")).toBeNull();

    const fromNumberInput = inputWithValue("+4930123456", ".settings-phone-presentation input");
    edit(fromNumberInput, " +4930123456 ");
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
    renderForm(analysis, {
      uiHints: wildcard ? { "plugins.entries.*.enabled": { label: "Plugin Enabled" } } : {},
      value: wildcard
        ? { plugins: { entries: { "voice-call": { enabled: true } } } }
        : { features: { beta: false } },
    });
    const checkbox = query('.settings-toggle__input[role="switch"]', HTMLInputElement);
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

  it("shows an unset default-on boolean as its placeholder instead of an off toggle", () => {
    renderForm(analyze({ cron: object({ enabled: { type: "boolean" } }) }), {
      uiHints: { "cron.enabled": { label: "Automations Enabled", placeholder: "Default: On" } },
    });

    expect(container.querySelector('.settings-toggle__input[role="switch"]')).toBeNull();
    const select = query('select[aria-label="Automations Enabled"]', HTMLSelectElement);
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe("Default: On");
    expect(onPatch).not.toHaveBeenCalled();
    edit(select, "1", "change");
    expect(onPatch).toHaveBeenLastCalledWith(["cron", "enabled"], false);
    edit(select, "0", "change");
    expect(onPatch).toHaveBeenLastCalledWith(["cron", "enabled"], true);
    edit(select, "__unset__", "change");
    expect(onPatch).toHaveBeenLastCalledWith(["cron", "enabled"], undefined);
  });

  it.each(
    [
      { key: "slack", additionalProperties: { type: "string" }, value: { channelA: "ok" } },
      { key: "accounts", additionalProperties: true, value: { default: { enabled: true } } },
    ].flatMap((entry) => [false, true].map((disabled) => ({ entry, disabled }))),
  )(
    "removes entries from the $entry.key map only when enabled (disabled=$disabled)",
    ({ entry: { key, additionalProperties, value }, disabled }) => {
      const analysis = analyze({ [key]: { type: "object", additionalProperties } });
      expect(analysis.unsupportedPaths).toEqual([]);
      renderForm(analysis, {
        value: { [key]: value },
        disabled,
      });
      const remove = query(".cfg-map button[aria-label^='Remove entry: ']", HTMLButtonElement);
      expect(remove.disabled).toBe(disabled);
      remove.click();
      if (disabled) {
        expect(onPatch).not.toHaveBeenCalled();
      } else {
        expect(onPatch).toHaveBeenCalledWith([key], {});
      }
    },
  );

  it("filters by authored metadata tags without rendering field chips", () => {
    renderForm(rootAnalysis, {
      uiHints: {
        "gateway.auth.token": { tags: ["security", "advanced", "secret"] },
      },
    });

    expect(container.querySelector(".cfg-tag")).toBeNull();

    renderForm(rootAnalysis, {
      uiHints: {
        "gateway.auth.token": { tags: ["security", "advanced"] },
      },
      searchQuery: "tag:advanced",
    });
    expect(texts(".settings-section__heading")[0]).toBe("Gateway");
    expect(texts(".settings-row__title")).toEqual(["Auth", "Token"]);
  });

  it("supports SecretInput unions in additionalProperties maps", () => {
    const refs = ["env", "file"].map((source) =>
      object(
        {
          source: { type: "string", const: source },
          provider: { type: "string" },
          id: { type: "string" },
        },
        { required: ["source", "provider", "id"], additionalProperties: false },
      ),
    );
    const analysis = analyze({
      models: object({
        providers: {
          type: "object",
          additionalProperties: object({
            apiKey: { anyOf: [{ type: "string" }, { oneOf: refs }] },
          }),
        },
      }),
    });
    expect(analysis.unsupportedPaths).toEqual([]);

    renderForm(analysis, {
      uiHints: {
        "models.providers.*.apiKey": { sensitive: true },
      },
      value: { models: { providers: { openai: { apiKey: "old" } } } }, // pragma: allowlist secret
      revealSensitive: true,
    });

    const apiKeyInput = inputWithValue(
      "old",
      "#config-section-models .cfg-map input.settings-input[type='text']",
    );
    edit(apiKeyInput, "new-key");
    expect(onPatch).toHaveBeenCalledWith(["models", "providers", "openai", "apiKey"], "new-key");
  });

  it.each([
    [{ lastTouchedAt: { anyOf: [{ type: "string" }, {}] } }, ["lastTouchedAt"], false],
    [{ note: { anyOf: [{ type: "string", nullable: true }] } }, [], true],
  ] satisfies Array<[Record<string, JsonSchema>, string[], boolean]>)(
    "analyzes unconstrained and nullable union shapes: %j",
    (properties, unsupported, nullable) => {
      const analysis = analyze(properties);
      expect(analysis.unsupportedPaths).toEqual(unsupported);
      if (nullable) {
        expect(analysis.schema?.properties?.note?.nullable).toBe(true);
      }
    },
  );

  it("renders metadata only on the outer array header", () => {
    const help = "Group sender ids.";
    const defaults = [["root-default"]];
    const analysis = analyze({
      groups: {
        type: "array",
        default: defaults,
        items: { type: "array", default: ["nested-default"], items: { type: "string" } },
      },
    });
    renderForm(analysis, {
      uiHints: { groups: { help } },
      value: { groups: [["first"], ["second"]] },
    });
    const descriptions = texts(".settings-row__desc");
    expect(descriptions.filter((text) => text === help)).toHaveLength(1);
    expect(
      descriptions.filter((text) => text === `Default: ${JSON.stringify(defaults)}`),
    ).toHaveLength(1);
    expect(descriptions.some((text) => text?.includes("nested-default"))).toBe(false);
  });

  it.each([true, false])("renders section help only with a docs URL: %s", async (hasDocs) => {
    renderForm(rootAnalysis, {
      uiHints: hasDocs
        ? { gateway: { docsUrl: "https://docs.openclaw.ai/gateway/configuration" } }
        : {},
      activeSection: "gateway",
    });

    if (!hasDocs) {
      expect(container.querySelector(".settings-section__help-button")).toBeNull();
      return;
    }
    const button = query(".settings-section__help-button", HTMLButtonElement);
    expect(button.getAttribute("aria-label")).toBe("Help for Gateway");
    const tooltip = expectElement(button.closest("openclaw-tooltip"), "section help tooltip");
    expect((tooltip as HTMLElement & { content: string }).content).toBe("Help for Gateway");
    const link = query(".settings-section__help-popover a", HTMLAnchorElement);
    expect(link.textContent?.trim()).toBe("Learn more");
    const popover = expectElement(link.closest('[role="dialog"]'), "section help popover");
    expect(button.getAttribute("aria-controls")).toBe(popover.id);
    expect(popover.getAttribute("aria-label")).toBe("Help for Gateway");
    expect(link.getAttribute("href")).toBe("https://docs.openclaw.ai/gateway/configuration");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    const { userEvent } = await import("vitest/browser");
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(popover.matches(":popover-open")).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const hidden = new Promise<void>((resolve) => {
      popover.addEventListener("overlay-after-hide", () => resolve(), { once: true });
    });
    await userEvent.keyboard("{Escape}");
    await hidden;
    expect(popover.matches(":popover-open")).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });
});
