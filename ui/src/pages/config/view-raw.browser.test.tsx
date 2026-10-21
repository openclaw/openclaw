import { beforeAll, expect, it, vi } from "vitest";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { baseProps, renderConfigInto } from "./config-view.test-support.tsx";
import type { ConfigProps } from "./view.tsx";
import "../../styles.css";

const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
});
const gateway = (mode: unknown) => ({ gateway: { mode } });
const changed = {
  raw: '{ gateway: { mode: "remote" } }',
  originalRaw: '{ gateway: { mode: "local" } }',
};
const gatewayField = (value: unknown) => ({
  schema: object({ gateway: object({ mode: { type: "string" } }) }),
  uiHints: { "gateway.mode": { advanced: false } },
  formValue: gateway(value),
});
const redacted = "[redacted - click reveal to view]";
const field = ".config-raw-field";
function setup(overrides: Partial<ConfigProps> = {}) {
  const props: ConfigProps = { ...baseProps(), formMode: "raw", ...overrides };
  const container = document.createElement("div");
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    container.querySelector<T>(selector)!;
  const text = (selector: string) => q(selector).textContent?.replace(/\s+/g, " ").trim();
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === name)!;
  const update = (patch: Partial<ConfigProps> = {}) => {
    Object.assign(props, patch);
    renderConfigInto(props, container);
  };
  const diff = () => q<HTMLDetailsElement>(".config-diff");
  const open = () => {
    diff().open = true;
    diff().dispatchEvent(new Event("toggle"));
  };
  const expectDiff = (...expected: string[]) =>
    expect(
      ["path", "from", "to"].map((part) => text(`.config-diff__item .config-diff__${part}`)),
    ).toEqual(expected);
  const mode = (form: boolean) =>
    expect(["Form", "Raw"].map((name) => button(name).ariaPressed)).toEqual([
      String(form),
      String(!form),
    ]);
  const hidden = () => {
    expect(text(`${field} .settings-count`)).toBe("1 secret redacted");
    expect(text(`${field} .callout.info`)).toBe(
      "1 sensitive value hidden. Use the reveal button above to edit the raw config.",
    );
    expect(q("textarea")).toBeNull();
  };
  const reveal = () => q(".config-raw-toggle").click();
  const input = () => q<HTMLInputElement>(".settings-input");
  const edit = (control: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
  };
  props.onViewStateChange = vi.fn(() => update());
  update();
  return {
    props,
    q,
    text,
    button,
    update,
    diff,
    open,
    expectDiff,
    mode,
    hidden,
    reveal,
    input,
    edit,
  };
}
beforeAll(() => warmJson5().then(() => undefined));

it("shows the form-unsafe banner only for populated unsupported paths", () => {
  const opaque = (): JsonSchema => ({ anyOf: [{ type: "string" }, {}] });
  const v = setup({
    formMode: "form",
    activeSection: "gateway",
    schema: object({
      gateway: object({ opaque: { title: "Opaque setting", ...opaque() } }),
      agents: object({ opaque: opaque() }),
    }),
    formValue: { gateway: {}, agents: { opaque: "off-scope" } },
  });
  expect(v.q(".config-content-callout .info")).toBeNull();
  expect(v.button("Form").title).toBe("");
  v.update({ formValue: { gateway: { opaque: "custom" }, agents: { opaque: "off-scope" } } });
  expect(v.text(".config-content-callout .callout.info")).toBe(
    "1 setting in this config can only be edited as text: gateway.opaque Open Raw editor",
  );
  expect(v.text(".config-content-callout code")).toBe("gateway.opaque");
  expect(v.button("Form").title).toBe("Form view can't safely edit some fields");
  v.button("Open Raw editor").click();
  expect(v.props.onFormModeChange).toHaveBeenCalledWith("raw");
  v.update({ formMode: "raw" });
  expect(v.text(".config-content")).not.toContain(
    "1 setting in this config can only be edited as text",
  );
  expect(v.q(field)).not.toBeNull();
});
it("keeps explicit open/save/discard controls in raw mode", () => {
  const v = setup({ ...changed, onOpenFile: vi.fn() });
  v.mode(false);
  expect(
    [...v.q(".config-raw-actions").querySelectorAll("button")].map((item) =>
      item.textContent?.trim(),
    ),
  ).toEqual(["Open", "Discard", "Save"]);
  for (const [name, callback] of [
    ["Open", v.props.onOpenFile],
    ["Discard", v.props.onRawDiscard],
    ["Save", v.props.onSave],
  ] as const) {
    v.button(name).click();
    expect(callback).toHaveBeenCalledTimes(1);
  }
  v.update({ formMode: "form" });
  expect(v.diff()).toBeNull();
  v.mode(true);
  v.button("Raw").click();
  expect(v.props.onFormModeChange).toHaveBeenCalledWith("raw");
});
it("pins the raw editor while an unsaved raw draft is authoritative", () => {
  const v = setup({ ...changed, formMode: "form", rawDraftPending: true });
  expect(v.q(".config-raw-actions")).not.toBeNull();
  expect(v.button("Form")).toMatchObject({ disabled: true, ariaPressed: "false" });
  expect(v.button("Raw").ariaPressed).toBe("true");
});
it.each(["clean", "saving", "applying"] as const)("locks editor controls while %s", (operation) => {
  const v = setup({
    ...gatewayField("remote"),
    originalRaw: "{}",
    formMode: operation === "applying" ? "form" : "raw",
    raw: operation === "clean" ? "{}" : changed.raw,
    saving: operation === "saving",
    applying: operation === "applying",
  });
  if (operation === "applying") {
    expect(v.q(".config-content input").hasAttribute("disabled")).toBe(true);
  } else if (operation === "clean") {
    expect([v.button("Save").disabled, v.button("Discard").disabled]).toEqual([true, true]);
  } else {
    expect(v.button("Saving…")).toMatchObject({ disabled: true, ariaBusy: "true" });
    expect(v.button("Saving…").querySelectorAll(".config-action-spinner")).toHaveLength(1);
    expect(v.q<HTMLTextAreaElement>("textarea").disabled).toBe(true);
  }
});
it("keeps sensitive raw config hidden until reveal before editing", () => {
  const formValue = { openai: { apiKey: "supersecret" } };
  const raw = JSON.stringify(formValue);
  const v = setup({ raw, originalRaw: raw, formValue });
  v.hidden();
  expect(v.q(".config-raw-toggle").ariaPressed).toBe("false");
  v.reveal();
  const input = v.q<HTMLTextAreaElement>("textarea");
  expect(input.value).toBe(raw);
  v.edit(input, input.value.replace("supersecret", "updatedsecret"));
  expect(v.props.onRawChange).toHaveBeenCalledWith(input.value);
});
it("opens raw pending changes without sending a fake raw edit", () => {
  const v = setup({ ...changed, formValue: gateway("remote") });
  expect(v.text(".config-diff__summary span")).toBe("View pending changes");
  expect(v.text(".config-diff__item")).toBe("Changes detected (JSON diff not available)");
  v.open();
  expect(v.props.onViewStateChange).toHaveBeenCalledTimes(1);
  expect(v.props.onRawChange).not.toHaveBeenCalled();
  v.expectDiff("gateway.mode", '"local"', '"remote"');
  v.update({ raw: v.props.originalRaw, formValue: gateway("local") });
  expect(v.diff()).toBeNull();
});
it.each([
  {
    path: "channels.discord.token.id",
    hint: "channels.discord.token",
    config: (id: string) => ({ channels: { discord: { token: { id } } } }),
  },
  {
    path: "integrations.foo.bar.credential",
    hint: "integrations.*.credential",
    config: (credential: string) => ({ integrations: { "foo.bar": { credential } } }),
  },
])("redacts pending changes under $hint until revealed", ({ path, hint, config }) => {
  const after = config("TOKEN_AFTER");
  const v = setup({
    raw: JSON.stringify(after),
    originalRaw: JSON.stringify(config("TOKEN_BEFORE")),
    uiHints: { [hint]: { sensitive: true, advanced: false } },
    formValue: after,
  });
  v.open();
  v.expectDiff(path, redacted, redacted);
  v.reveal();
  flush();
  v.expectDiff(path, '"TOKEN_BEFORE"', '"TOKEN_AFTER"');
});
it("resets raw reveal state when the config context changes", () => {
  const snapshot = (id: string) => ({
    configPath: `/tmp/openclaw-${id.toLowerCase()}.json5`,
    raw: `{ token: "TOKEN_${id}_AFTER" }`,
    originalRaw: `{ token: "TOKEN_${id}_BEFORE" }`,
    formValue: { token: `TOKEN_${id}_AFTER` },
  });
  const v = setup({ ...snapshot("A"), uiHints: { token: { sensitive: true } } });
  v.open();
  v.reveal();
  v.expectDiff("token", '"TOKEN_A_BEFORE"', '"TOKEN_A_AFTER"');
  v.update(snapshot("B"));
  v.hidden();
  expect(v.diff().open).toBe(false);
  v.open();
  v.expectDiff("token", redacted, redacted);
});
it("renders structured SecretRef values without stringifying", () => {
  const token = { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" };
  const v = setup({
    schema: object({ channels: object({ discord: object({ token: { type: "string" } }) }) }),
    uiHints: { "channels.discord.token": { sensitive: true, advanced: false } },
    formMode: "form",
    formValue: { channels: { discord: { token } } },
  });
  const input = v.input();
  expect(input).toMatchObject({
    readOnly: true,
    value: "",
    placeholder: "Structured value (SecretRef) - use Raw mode to edit",
  });
  v.edit(input, "[object Object]");
  input.dispatchEvent(new Event("change", { bubbles: true }));
  expect(v.props.onFormPatch).not.toHaveBeenCalled();
  v.update({ rawAvailable: false, formMode: "raw" });
  v.mode(true);
  expect(v.button("Raw")).toMatchObject({
    ariaPressed: "false",
    disabled: true,
    title: "Raw mode unavailable for this snapshot",
  });
  expect(v.q(field)).toBeNull();
  v.button("Raw").click();
  expect(v.props.onFormModeChange).not.toHaveBeenCalled();
  expect(v.input().placeholder).toBe(
    "Structured value (SecretRef) - edit the config file directly",
  );
});
it("keeps malformed non-SecretRef object values editable when raw mode is unavailable", () => {
  const v = setup({ rawAvailable: false, ...gatewayField({ malformed: true }) });
  const input = v.input();
  expect(input).toMatchObject({ readOnly: false, value: '{  "malformed": true}', placeholder: "" });
  expect(input.value).not.toBe("[object Object]");
  v.edit(input, "local");
  expect(v.props.onFormPatch).toHaveBeenCalledWith(["gateway", "mode"], "local");
});
