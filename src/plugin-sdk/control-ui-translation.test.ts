import { expect, it } from "vitest";
import { translateControlUiMessage } from "./control-ui-translation.js";

const english = {
  nested: { title: "English title" },
  fallback: "English fallback",
  empty: "English empty",
  object: "English object",
  greeting: "Hello {name}, {missing} {dash-name}!",
};
const french = {
  nested: { title: "Titre" },
  empty: "",
  object: { nested: "Not a leaf" },
  greeting: "Bonjour {name}, {missing} {dash-name}!",
};
const messages = (locale: string) =>
  locale === "en" ? english : locale === "fr" ? french : undefined;

it.each([
  ["fr", "nested.title", "Titre"],
  ["fr", "fallback", "English fallback"],
  ["missing", "fallback", "English fallback"],
  ["fr", "empty", ""],
  ["fr", "object", "object"],
  ["fr", "nested", "nested"],
  ["fr", "greeting.child", "greeting.child"],
  ["fr", "missing.key", "missing.key"],
])("preserves lookup for %s/%s", (locale, key, expected) => {
  expect(translateControlUiMessage(messages, locale, key)).toBe(expected);
});

it("interpolates string params while preserving unresolved and non-word placeholders", () => {
  expect(
    translateControlUiMessage(messages, "fr", "greeting", {
      name: "Ada",
      "dash-name": "Unchanged",
    }),
  ).toBe("Bonjour Ada, {missing} {dash-name}!");
  expect(translateControlUiMessage(messages, "fr", "greeting", { name: "" })).toBe(
    "Bonjour , {missing} {dash-name}!",
  );
  expect(translateControlUiMessage(messages, "fr", "greeting")).toBe(
    "Bonjour {name}, {missing} {dash-name}!",
  );
});

it("reads current plugin-owned maps without sharing catalog state", () => {
  let first = { title: "First plugin" };
  const firstMessages = () => first;
  const secondMessages = () => ({ title: "Second plugin" });

  expect(translateControlUiMessage(firstMessages, "en", "title")).toBe("First plugin");
  expect(translateControlUiMessage(secondMessages, "en", "title")).toBe("Second plugin");
  first = { title: "Updated first plugin" };
  expect(translateControlUiMessage(firstMessages, "en", "title")).toBe("Updated first plugin");
});
