import type { Page } from "playwright";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";

export async function openMockAbortableRun(currentPage: Page, baseUrl: string, runId: string) {
  const sessionKey = "agent:main:main";
  const sessionInfo = {
    key: sessionKey,
    sessionId: `session:${sessionKey}`,
    kind: "direct",
    updatedAt: 1,
    hasActiveRun: true,
    activeRunIds: [runId],
    status: "running",
  };
  const gateway = await installMockGateway(currentPage, {
    sessionKey,
    sessions: [sessionInfo],
    sessionInfo,
    inFlightRun: { runId, text: "The fixture run is still working." },
    methodResponses: { "chat.abort": { ok: true, aborted: false, runIds: [] } },
  });
  await currentPage.goto(controlUiSessionUrl(baseUrl, sessionKey));
  const stop = currentPage.getByRole("button", { name: "Stop generating" });
  const composer = currentPage.locator(".agent-chat__input textarea");
  await stop.waitFor({ state: "visible" });
  await currentPage.getByText("The fixture run is still working.", { exact: true }).waitFor();
  return { gateway, sessionKey, runId, stop, composer };
}
