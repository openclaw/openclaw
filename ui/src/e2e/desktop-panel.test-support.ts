import type { Page } from "playwright";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";

export function sessionsList(placement: "local" | "active") {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        key: "main",
        kind: "direct",
        label: "Main",
        placement: {
          state: placement,
          ...(placement === "active" ? { environmentId: "worker-desktop-1" } : {}),
        },
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

export async function openPalette(page: import("playwright").Page) {
  await waitForControlUiGatewayReady(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
  });
  await page
    .locator("openclaw-command-palette")
    .getByRole("textbox", { name: "Search or start a task…" })
    .waitFor();
}

export async function openDesktopPanel(page: import("playwright").Page, baseUrl: string) {
  await page.goto(`${baseUrl}activity`);
  await openPalette(page);
  await page.getByRole("option", { name: "Desktop", exact: true }).click();
  const panel = page.locator("openclaw-desktop-panel");
  await panel.locator("section[aria-label='Desktop']").waitFor();
  return panel;
}

export const observe = (token: string, control = false, extra: object = {}) => ({
  transport: "rfb",
  wsPath: `/desktop/observe?token=${token}`,
  expiresAtMs: 60_000,
  control,
  ...extra,
});
export const observationCases = () => ({
  cases: [false, true].map((control) => ({
    match: { source: { kind: "environment", environmentId: "worker-desktop-1" }, control },
    response: observe(control ? "control" : "view", control),
  })),
});
export const credentialsRequired = (target: string) => ({
  __mockError: {
    code: "INVALID_REQUEST",
    message: `VNC password is required to observe this ${target}`,
    details: { code: "DESKTOP_CREDENTIALS_REQUIRED", auth: "vnc-password" },
  },
});
export const unavailable = (message: string) => ({ __mockError: { code: "UNAVAILABLE", message } });

export const workerDesktopEnvironment = {
  id: "worker-desktop-1",
  type: "worker",
  status: "available",
  desktop: true,
  worker: {
    providerId: "crabbox",
    state: "attached",
    ageMs: 1_000,
    attachedSessionIds: ["main"],
    tunnelStatus: "connected",
    desktopApps: ["browser", "terminal"],
  },
} as const;

export const workerEnvironment = (worker: object = {}, id = "worker-desktop-1") => ({
  ...workerDesktopEnvironment,
  id,
  worker: { ...workerDesktopEnvironment.worker, ...worker },
});
export const desktopGateway = (
  page: Page,
  environments: readonly unknown[] | null = [],
  observation?: object,
  scenario: ControlUiMockGatewayScenario = {},
) =>
  installMockGateway(page, {
    featureMethods: ["desktop.observe", "environments.list"],
    ...scenario,
    methodResponses: {
      "sessions.list": sessionsList("local"),
      ...(environments && { "environments.list": { environments } }),
      ...(observation && { "desktop.observe": observation }),
      ...scenario.methodResponses,
    },
  });
