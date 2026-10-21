import type { Page } from "playwright";
import { expect } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

export async function identityFixture(
  page: Page,
  baseUrl: string,
  surface: "sessions" | "sidebar" | "selection" | "header",
  kind: "group" | "rename",
) {
  const batch = surface === "selection";
  const method = batch ? "sessions.patchMany" : "sessions.patch";
  const original = sessionRow(
    `agent:main:${kind}-identity`,
    "Original session",
    kind === "group" ? Date.now() : Date.parse("2026-08-27T12:00:00.000Z"),
    kind === "group" ? { sessionId: "original-session" } : undefined,
  );
  const survivor = sessionRow("agent:main:group-survivor", "Surviving session", Date.now());
  const replacement = {
    ...original,
    sessionId: "replacement-session",
    label: "Replacement session",
    displayName: "Replacement session",
    updatedAt: original.updatedAt + 1_000,
  };
  const gateway = await installMockGateway(page, {
    deferredMethods: kind === "group" ? ["sessions.groups.put", method] : [method],
    methodResponses: {
      "sessions.list": sessionsListResponse(kind === "group" ? [original, survivor] : [original]),
    },
    sessionKey: original.key,
  });
  await page.goto(
    surface === "sessions" ? `${baseUrl}sessions` : controlUiSessionUrl(baseUrl, original.key),
  );
  const row =
    surface === "sessions"
      ? page.locator(".sessions-table tbody tr", { hasText: original.key })
      : page.locator(`.sidebar-recent-session[data-session-key="${original.key}"]`);
  await row.waitFor({ state: "visible" });
  const replace = async () => {
    await gateway.setSessionsListResponse(
      sessionsListResponse(kind === "group" ? [replacement, survivor] : [replacement]),
    );
    await gateway.emitGatewayEvent("sessions.changed", {
      ...replacement,
      sessionKey: original.key,
      reason: "create",
    });
    await expect.poll(() => row.textContent()).toContain(replacement.label);
  };
  return { original, survivor, replacement, gateway, row, batch, method, replace };
}
