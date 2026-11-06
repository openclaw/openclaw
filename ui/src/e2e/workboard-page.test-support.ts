import type { Page } from "playwright";
import { type ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";

export async function installWorkboardPage(
  page: Page,
  baseUrl: string,
  boardId: string,
  methodResponses: ControlUiMockGatewayScenario["methodResponses"],
) {
  const gateway = await installNativePluginMockGateway(page, { ...workboardUi, methodResponses });
  await seedChatSettings(page, baseUrl, {
    railShortcuts: ["route:sessions", `plugin:workboard/board-${boardId}`],
  });
  return gateway;
}
