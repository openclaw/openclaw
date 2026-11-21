import type { Page } from "playwright";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  TALK_READY_HISTORY_MESSAGE,
  videoTalkCatalog,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export const createTalkRegressionSuite = (name: string) =>
  createControlUiE2eSuite({
    name,
    browserLaunchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  });

export function installTalkGateway(
  page: Page,
  voiceSessionId: string,
  options: { readyHistory?: boolean; offerUrl?: string; offerResponseMaxBytes?: number } = {},
) {
  const { readyHistory = true, ...client } = options;
  return installMockGateway(page, {
    ...(readyHistory ? { historyMessages: [TALK_READY_HISTORY_MESSAGE] } : {}),
    methodResponses: {
      "talk.catalog": videoTalkCatalog("openai"),
      "talk.client.create": {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "test-client-secret",
        voiceSessionId,
        ...client,
      },
    },
  });
}
