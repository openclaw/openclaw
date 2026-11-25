// @vitest-environment node
import { expect, it, onTestFinished } from "vitest";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import { i18n } from "../../../i18n/lib/translate.ts";
import { de } from "../../../i18n/locales/de.ts";
import { catalogToolOperation } from "./chat-tool-operation-copy.ts";

const search = { id: "search", name: "web_search" };

it.each([{ count: 5 }, { query: " \n ", count: 5 }, { query: 7, count: 5 }])(
  "keeps the phase label when there is no search text: %j",
  (args) => {
    expect(catalogToolOperation({ ...search, args }, "succeeded")?.label).toBe("Searched the web");
  },
);

it("recognizes a single-token device name only when the description confirms it", () => {
  const args = { action: "describe", node: "Studio" };
  const details = { nodeId: "a".repeat(64), displayName: "Studio" };
  const direct = { id: "device", name: "nodes", args, details };
  const dispatched = {
    id: "device",
    name: "tool_call",
    args: { id: "nodes", args },
    details: { tool: { name: "nodes" }, result: { details } },
  };
  for (const card of [direct, dispatched]) {
    expect(catalogToolOperation(card, "succeeded")?.label).toBe("Described node · Studio");
  }
  for (const input of [
    { node: "Studio" },
    { nodeId: "Lab Mac" },
    { node: "192.0.2.4" },
    { node: "abc123" },
    { node: "https://demo:example@host.invalid/report" },
  ]) {
    expect(
      catalogToolOperation(
        { ...direct, details: undefined, args: { action: "describe", ...input } },
        "running",
      )?.label,
    ).toBe("Describing node");
  }
});

it("lets the active locale place and quote running and blocked web search queries", async () => {
  const restore = captureI18nStateForTesting();
  onTestFinished(async () => {
    i18n.registerTranslation("de", de);
    await restore();
  });
  i18n.registerTranslation("de", {
    chat: {
      toolCards: {
        operationLabels: {
          web_search: {
            default: {
              actionWithQuery: "„{query}“ im Web suchen",
              running: "Websuche läuft",
              runningWithQuery: "Nach „{query}“ wird im Web gesucht",
            },
          },
        },
      },
    },
  });
  await i18n.setLocale("de");
  const card = { ...search, args: { query: "API docs", count: 5 } };
  expect(catalogToolOperation(card, "running")?.label).toBe("Nach „API docs“ wird im Web gesucht");
  expect(catalogToolOperation(card, "blocked")?.label).toBe("„API docs“ im Web suchen");
});
