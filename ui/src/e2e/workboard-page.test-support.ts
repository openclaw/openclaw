import type { Page } from "playwright";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";

export async function installWorkboardPage(
  page: Page,
  baseUrl: string,
  boardId: string,
  methodResponses: ControlUiMockGatewayScenario["methodResponses"],
  locale?: string,
) {
  const gateway = await installMockGateway(page, { ...workboardUi, methodResponses });
  if (locale) {
    await page.addInitScript(
      (value) => localStorage.setItem("openclaw.i18n.locale", value),
      locale,
    );
  }
  await seedChatSettings(page, baseUrl, {
    railShortcuts: ["route:agents-home", `plugin:workboard/board-${boardId}`],
  });
  return gateway;
}
