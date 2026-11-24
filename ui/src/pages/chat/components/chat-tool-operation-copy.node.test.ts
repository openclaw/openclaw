// @vitest-environment node
import { expect, it, onTestFinished } from "vitest";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import { i18n } from "../../../i18n/lib/translate.ts";
import { de } from "../../../i18n/locales/de.ts";
import { catalogToolLabel } from "./chat-tool-operation-copy.ts";

const search = { id: "search", name: "web_search" };

it.each([{ count: 5 }, { query: " \n ", count: 5 }, { query: 7, count: 5 }])(
  "keeps the phase label when there is no search text: %j",
  (args) => {
    expect(catalogToolLabel({ ...search, args }, "succeeded")).toBe("Searched the web");
  },
);

it("lets the active locale place and quote the running web search query", async () => {
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
              running: "Websuche läuft",
              runningWithQuery: "Nach „{query}“ wird im Web gesucht",
            },
          },
        },
      },
    },
  });
  await i18n.setLocale("de");
  expect(catalogToolLabel({ ...search, args: { query: "API docs", count: 5 } }, "running")).toBe(
    "Nach „API docs“ wird im Web gesucht",
  );
});
