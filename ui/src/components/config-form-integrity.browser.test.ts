import { describe, expect, it, vi } from "vitest";
import {
  expectElement,
  renderAnalyzedFormFixture,
  renderArrayFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import { analyzeConfigSchema } from "./config-form.analyze.ts";
import { configFieldId } from "./config-form.shared.ts";

function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  return expectElement(root.querySelector<T>(selector), selector);
}

function button(root: ParentNode, label: string) {
  return expectElement(
    Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) => item.textContent?.trim() === label,
    ),
    label,
  );
}

function typeValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("config form integrity", () => {
  it("applies schema constraints and derives bounded repeated defaults", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        laboratory: {
          type: "object",
          required: ["endpoint", "retryBudget"],
          properties: {
            endpoint: {
              type: "string",
              description: "Lowercase slug.",
              minLength: 3,
              maxLength: 16,
              pattern: "[a-z-]+",
            },
            optionalAlias: {
              type: "string",
              minLength: 3,
            },
            relayUrl: {
              type: "string",
              description: "Relay origin.",
              format: "uri",
            },
            explicitEmpty: {
              type: "string",
              minLength: 0,
              pattern: "^$",
            },
            glyph: {
              type: "string",
              maxLength: 1,
              pattern: "^.$",
            },
            codes: {
              type: "array",
              items: {
                type: "string",
                minLength: 3,
                pattern: "^[0-9]+$",
              },
            },
            limited: {
              type: "array",
              maxItems: 1,
              items: { type: "integer" },
            },
            provider: {
              type: "string",
              description: "Execution provider.",
              enum: ["a", "b", "c", "d", "e", "f"],
            },
            apiKey: { type: "string" },
            retryBudget: {
              type: "integer",
              description: "Even values from two through eight.",
              minimum: 2,
              maximum: 8,
              multipleOf: 2,
            },
            weights: {
              type: "array",
              items: { type: "integer", minimum: 2, maximum: 8, multipleOf: 2 },
            },
          },
        },
      },
    });
    // Zod emits `format` for .url()/.email(); the form must keep those fields
    // editable instead of forcing the whole section into Raw mode.
    expect(analysis.unsupportedPaths).toEqual([]);
    renderAnalyzedFormFixture(container, analysis, {
      uiHints: { "laboratory.apiKey": { sensitive: true } },
      value: {
        laboratory: {
          endpoint: "local-api",
          optionalAlias: "main",
          relayUrl: "https://relay.example",
          explicitEmpty: "present",
          glyph: "a",
          codes: [],
          limited: [1],
          provider: "a",
          apiKey: "test-secret",
          retryBudget: 8,
          weights: [2],
        },
      },
      onPatch,
    });

    const endpoint = query<HTMLInputElement>(container, "input[aria-label='Endpoint']");
    expect(endpoint.getAttribute("minlength")).toBeNull();
    expect(endpoint.getAttribute("maxlength")).toBeNull();
    expect(endpoint.pattern).toBe("");
    const endpointErrorId = configFieldId(["laboratory", "endpoint"], "scalar-error");
    expect(endpoint.getAttribute("aria-describedby")?.split(" ")).toEqual([
      configFieldId(["laboratory", "endpoint"], "description"),
      endpointErrorId,
    ]);
    typeValue(endpoint, "Xlocal-apiY");
    expect(onPatch).toHaveBeenCalledWith(["laboratory", "endpoint"], "Xlocal-apiY");

    typeValue(endpoint, " a ");
    expect(onPatch).toHaveBeenCalledWith(["laboratory", "endpoint"], " a ");
    endpoint.dispatchEvent(new Event("change", { bubbles: true }));
    expect(endpoint.value).toBe(" a ");
    expect(endpoint.getAttribute("aria-invalid")).toBe("false");
    expect(onPatch).not.toHaveBeenCalledWith(["laboratory", "endpoint"], "a");

    typeValue(endpoint, "123");
    expect(endpoint.getAttribute("aria-invalid")).toBe("true");
    const endpointError = expectElement(
      document.getElementById(endpointErrorId),
      "associated endpoint validation message",
    );
    expect(endpointError.hidden).toBe(false);
    expect(endpointError.getAttribute("role")).toBe("alert");
    expect(endpointError.textContent).toBe(endpoint.validationMessage);
    expect(onPatch).not.toHaveBeenCalledWith(["laboratory", "endpoint"], "123");

    typeValue(endpoint, "");
    expect(endpoint.getAttribute("aria-invalid")).toBe("true");

    typeValue(endpoint, "valid-slug");
    expect(endpointError.hidden).toBe(true);
    expect(endpointError.textContent).toBe("");

    const relayUrl = query<HTMLInputElement>(container, "input[aria-label='Relay Url']");
    typeValue(relayUrl, "relay.example");
    expect(relayUrl.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalledWith(["laboratory", "relayUrl"], "relay.example");
    typeValue(relayUrl, "https://relay.example/");
    expect(relayUrl.getAttribute("aria-invalid")).toBe("false");
    expect(onPatch).toHaveBeenCalledWith(["laboratory", "relayUrl"], "https://relay.example/");

    const optionalAlias = query<HTMLInputElement>(container, "input[aria-label='Optional Alias']");
    typeValue(optionalAlias, "");
    expect(optionalAlias.getAttribute("aria-invalid")).toBe("false");
    expect(onPatch).toHaveBeenCalledWith(["laboratory", "optionalAlias"], undefined);
    const explicitEmpty = query<HTMLInputElement>(container, "input[aria-label='Explicit Empty']");
    typeValue(explicitEmpty, "");
    expect(explicitEmpty.getAttribute("aria-invalid")).toBe("false");
    expect(onPatch).toHaveBeenCalledWith(["laboratory", "explicitEmpty"], "");
    const glyph = query<HTMLInputElement>(container, "input[aria-label='Glyph']");
    expect(glyph.getAttribute("maxlength")).toBeNull();
    typeValue(glyph, "😀");
    expect(glyph.getAttribute("aria-invalid")).toBe("false");
    expect(onPatch).toHaveBeenCalledWith(["laboratory", "glyph"], "😀");
    const codes = expectElement(
      Array.from(container.querySelectorAll<HTMLElement>(".cfg-array")).find((block) =>
        block.textContent?.includes("Codes"),
      ),
      "patterned string array",
    );
    const addCode = button(codes, "Add");
    expect(addCode.disabled).toBe(false);
    addCode.click();
    const codeDraftHost = query(codes, "openclaw-config-form-collection-draft");
    flush();
    const codeDraft = query<HTMLElement>(codes, ".cfg-collection-draft");
    expect(onPatch).not.toHaveBeenCalledWith(["laboratory", "codes"], expect.anything());
    const codeValue = query<HTMLInputElement>(codeDraft, "input[aria-label='Add: Codes']");
    const commitCode = button(codeDraft, "Add");
    codeValue.value = "abc";
    commitCode.click();
    flush();
    const invalidCodeValue = query<HTMLInputElement>(
      codeDraftHost,
      "[data-collection-draft-value]",
    );
    expect(invalidCodeValue.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalledWith(["laboratory", "codes"], expect.anything());
    typeValue(invalidCodeValue, "123");
    flush();
    button(codeDraftHost, "Add").click();
    expect(onPatch).toHaveBeenCalledWith(["laboratory", "codes"], ["123"]);
    flush();
    expect(codes.querySelector(".cfg-collection-draft")).toBeNull();
    const limited = expectElement(
      Array.from(container.querySelectorAll<HTMLElement>(".cfg-array")).find((block) =>
        block.textContent?.includes("Limited"),
      ),
      "max-items array",
    );
    const addLimited = button(limited, "Add");
    expect(addLimited.disabled).toBe(true);
    const provider = query<HTMLSelectElement>(container, "select[aria-label='Provider']");
    expect(provider.getAttribute("aria-describedby")).toBe(
      "config-field-s10-006c00610062006f007200610074006f00720079_s8-00700072006f00760069006400650072-description",
    );
    const apiKey = query<HTMLInputElement>(container, "input[aria-label='Api Key']");
    expect(apiKey.readOnly).toBe(true);
    expect(apiKey.classList.contains("cfg-redacted")).toBe(true);

    const retryBudget = query<HTMLInputElement>(container, "input[aria-label='Retry Budget']");
    expect(retryBudget.min).toBe("2");
    expect(retryBudget.max).toBe("8");
    expect(retryBudget.step).toBe("2");
    const weightInput = query<HTMLInputElement>(
      container,
      ".cfg-array input[aria-label='Weights']",
    );

    typeValue(retryBudget, "");
    expect(retryBudget.getAttribute("aria-invalid")).toBe("true");
    expect(retryBudget.validationMessage).not.toBe("");
    const retryErrorId = configFieldId(["laboratory", "retryBudget"], "scalar-error");
    const retryError = expectElement(
      document.getElementById(retryErrorId),
      "associated retry budget validation message",
    );
    expect(retryBudget.getAttribute("aria-describedby")?.split(" ")).toContain(retryErrorId);
    expect(retryError.hidden).toBe(false);
    expect(retryError.textContent).toBe(retryBudget.validationMessage);
    expect(onPatch).not.toHaveBeenCalledWith(["laboratory", "retryBudget"], undefined);

    typeValue(retryBudget, "3");
    expect(retryBudget.validationMessage).not.toBe("");
    retryBudget.dispatchEvent(new Event("change", { bubbles: true }));
    expect(retryBudget.value).toBe("4");
    expect(retryBudget.validationMessage).toBe("");
    expect(retryBudget.checkValidity()).toBe(true);
    expect(onPatch).toHaveBeenCalledWith(["laboratory", "retryBudget"], 4);

    const increment = query<HTMLButtonElement>(container, "button[aria-label='Retry Budget: +2']");
    increment.click();
    expect(onPatch).toHaveBeenCalledWith(["laboratory", "retryBudget"], 8);

    const addButton = button(
      expectElement(weightInput.closest(".cfg-array"), "bounded array"),
      "Add",
    );
    addButton.click();
    expect(onPatch).toHaveBeenCalledWith(["laboratory", "weights"], [2, 2]);
    container.remove();
  });

  it.each(["primary", "constructor"])(
    "commits typed map entry %s only after the local draft is valid",
    (entryKey) => {
      const onPatch = vi.fn();
      const container = document.createElement("div");
      document.body.append(container);
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: {
          aliases: {
            type: "object",
            properties: {
              fixed: { type: "integer" },
            },
            additionalProperties: {
              type: "string",
              minLength: 3,
              pattern: "^[0-9]+$",
            },
          },
        },
      });
      renderAnalyzedFormFixture(container, analysis, {
        value: { aliases: {} },
        onPatch,
      });

      const addEntry = button(container, "Add Entry");
      addEntry.click();
      const draftHost = query(container, "openclaw-config-form-collection-draft");
      flush();
      const draft = query<HTMLElement>(container, ".cfg-map .cfg-collection-draft");
      const key = query<HTMLInputElement>(draft, "[data-collection-draft-key]");
      const value = query<HTMLInputElement>(draft, "[data-collection-draft-value]");
      const commit = button(draft, "Add Entry");
      typeValue(key, "fixed");
      typeValue(value, "123");
      flush();
      commit.click();
      flush();
      const reservedKey = query<HTMLInputElement>(draftHost, "[data-collection-draft-key]");
      expect(reservedKey.getAttribute("aria-invalid")).toBe("true");
      expect(onPatch).not.toHaveBeenCalled();

      typeValue(reservedKey, entryKey);
      const invalidValueInput = query<HTMLInputElement>(draftHost, "[data-collection-draft-value]");
      typeValue(invalidValueInput, "abc");
      flush();
      button(draftHost, "Add Entry").click();
      flush();
      const invalidValue = query<HTMLInputElement>(draftHost, "[data-collection-draft-value]");
      expect(invalidValue.getAttribute("aria-invalid")).toBe("true");
      expect(onPatch).not.toHaveBeenCalled();

      typeValue(invalidValue, "123");
      flush();
      button(draftHost, "Add Entry").click();
      expect(onPatch).toHaveBeenCalledWith(["aliases"], { [entryKey]: "123" });
      flush();
      expect(container.querySelector(".cfg-map .cfg-collection-draft")).toBeNull();
      container.remove();
    },
  );

  it("preserves unaffected scalar drafts and resets changed repeated rows", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        values: {
          type: "array",
          items: { type: "string", pattern: "^[0-9]+$" },
        },
      },
    });
    const renderValues = (values: string[]) => {
      renderAnalyzedFormFixture(container, analysis, {
        value: { values },
        onPatch,
      });
    };

    renderValues(["111", "222"]);
    const first = query<HTMLInputElement>(container, "input[aria-label='Values']");
    typeValue(first, "abc");
    expect(first.getAttribute("aria-invalid")).toBe("true");
    expect(first.validationMessage).not.toBe("");

    for (const values of [["111", "333"], ["111", "333", "444"], ["111"]]) {
      renderValues(values);
      const preserved = query<HTMLInputElement>(container, "input[aria-label='Values']");
      expect(preserved).toBe(first);
      expect(preserved.value).toBe("abc");
      expect(preserved.getAttribute("aria-invalid")).toBe("true");
      expect(preserved.validationMessage).not.toBe("");
    }

    renderValues(["444"]);
    const changed = query<HTMLInputElement>(container, "input[aria-label='Values']");
    expect(changed.value).toBe("444");
    expect(changed.getAttribute("aria-invalid")).toBe("false");
    expect(changed.validationMessage).toBe("");
  });

  it("clears scalar validity when sensitive presentation changes", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        apiKey: { type: "string", pattern: "^[0-9]+$" },
      },
    });
    const renderSensitive = (revealSensitive: boolean) => {
      renderAnalyzedFormFixture(container, analysis, {
        uiHints: { apiKey: { sensitive: true } },
        value: { apiKey: "123" },
        revealSensitive,
        onPatch,
      });
    };

    renderSensitive(true);
    const input = query<HTMLInputElement>(container, "input[aria-label='Api Key']");
    typeValue(input, "abc");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.validationMessage).not.toBe("");
    expect(onPatch).not.toHaveBeenCalled();

    renderSensitive(false);
    const hidden = query<HTMLInputElement>(container, "input[aria-label='Api Key']");
    expect(hidden).toBe(input);
    expect(hidden.value).toBe("");
    expect(hidden.getAttribute("aria-invalid")).toBe("false");
    expect(hidden.validationMessage).toBe("");

    renderSensitive(true);
    const revealed = query<HTMLInputElement>(container, "input[aria-label='Api Key']");
    expect(revealed).toBe(input);
    expect(revealed.value).toBe("123");
    expect(revealed.getAttribute("aria-invalid")).toBe("false");
    expect(revealed.validationMessage).toBe("");
  });

  it("retains unset array drafts until the collection source changes", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const schema = {
      type: "array",
      items: { type: "string", pattern: "^[0-9]+$" },
    };
    const renderValue = (value: unknown) => {
      renderArrayFixture(container, {
        schema,
        value,
        path: ["codes"],
        onPatch,
      });
    };

    renderValue(undefined);
    const codes = query<HTMLElement>(container, ".cfg-array");
    const draftHost = query(codes, "openclaw-config-form-collection-draft");
    flush();
    button(codes, "Add").click();
    flush();
    const draftValue = query<HTMLInputElement>(draftHost, "[data-collection-draft-value]");
    typeValue(draftValue, "123");
    flush();

    renderValue(undefined);
    flush();
    expect(query<HTMLInputElement>(draftHost, "[data-collection-draft-value]").value).toBe("123");

    renderValue([]);
    flush();
    expect(draftHost.querySelector(".cfg-collection-draft")).toBeNull();
    container.remove();
  });

  it("retains invalid JSON drafts with an inline accessible error", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const primaryValue = { enabled: true };
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        accounts: { type: "object", additionalProperties: true },
      },
    });
    renderAnalyzedFormFixture(container, analysis, {
      value: { accounts: { primary: primaryValue, secondary: { enabled: false } } },
      onPatch,
    });

    const textarea = query<HTMLTextAreaElement>(container, ".cfg-map textarea");
    expect(textarea.getAttribute("aria-label")).toBe("primary: JSON value");
    typeValue(textarea, '{"enabled":');
    textarea.dispatchEvent(new Event("change", { bubbles: true }));

    expect(textarea.value).toBe('{"enabled":');
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    const errorId = configFieldId(["accounts", "primary"], "json-error");
    expect(textarea.getAttribute("aria-describedby")?.split(" ")).toContain(errorId);
    const error = query<HTMLElement>(container, `#${errorId}`);
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("valid JSON");
    expect(onPatch).not.toHaveBeenCalled();

    typeValue(textarea, '{"enabled":false}');
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    expect(textarea.getAttribute("aria-invalid")).toBe("false");
    expect(error.hidden).toBe(true);
    expect(onPatch).toHaveBeenCalledWith(["accounts", "primary"], { enabled: false });

    typeValue(textarea, '{"enabled":');
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    renderAnalyzedFormFixture(container, analysis, {
      value: { accounts: { primary: primaryValue, secondary: { enabled: true } } },
      onPatch,
    });
    const siblingUpdateTextarea = query<HTMLTextAreaElement>(
      container,
      ".cfg-map textarea[aria-label='primary: JSON value']",
    );
    expect(siblingUpdateTextarea.value).toBe('{"enabled":');
    expect(siblingUpdateTextarea.getAttribute("aria-invalid")).toBe("true");
    expect(siblingUpdateTextarea.validationMessage).not.toBe("");
    expect(error.hidden).toBe(false);

    // A genuinely external change (different content) still resets in-progress
    // text; identity churn with identical bytes (autosave ack) must not.
    renderAnalyzedFormFixture(container, analysis, {
      value: { accounts: { primary: { enabled: false } } },
      onPatch,
    });
    const resetTextarea = query<HTMLTextAreaElement>(container, ".cfg-map textarea");
    expect(resetTextarea.value).toContain('"enabled": false');
    expect(resetTextarea.getAttribute("aria-invalid")).toBe("false");
    expect(resetTextarea.validationMessage).toBe("");
    expect(error.hidden).toBe(true);
  });
});
