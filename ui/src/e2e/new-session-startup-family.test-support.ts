import type { Page } from "playwright";
import { expect } from "vitest";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import type { SessionPlacementRecovery } from "../lib/sessions/session-placement-recovery.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  createCloudAgentsListResponse,
  createdSessionListResult,
  installMockGateway,
  LOCAL_GIT_WORKSPACE_RESPONSES,
} from "./new-session-page.test-support.ts";

export function cloudWorkspaceResponses(sessionKey?: string) {
  return {
    "agents.list": createCloudAgentsListResponse(),
    "environments.list": { environments: [], profiles: [{ id: "aws", providerId: "crabbox" }] },
    "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
    ...(sessionKey
      ? {
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
        }
      : {}),
  };
}

export async function openCloudDraft(
  page: Page,
  baseUrl: string,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  popover = ".new-session-page__where-popover",
) {
  await page.goto(`${baseUrl}new`);
  await gateway.waitForRequest("environments.list");
  await page.locator("#new-session-where-trigger").click();
  await page.locator(popover).getByRole("button", { name: "aws", exact: true }).click();
}

export async function disableComposerStorage(page: Page) {
  await page.evaluate(() => {
    const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
    Storage.prototype.setItem = function (key: string, value: string) {
      if (
        key.startsWith("openclaw.new-session.session-placement-recovery.v1:") ||
        key.startsWith("openclaw.control-ui-e2e.")
      ) {
        originalSetItem(key, value);
        return;
      }
      throw new DOMException("composer storage disabled", "SecurityError");
    };
  });
}

type WithoutScope<T> = T extends unknown ? Omit<T, "gatewayUrl" | "recoveryScope"> : never;

export async function saveRecovery<T extends WithoutScope<SessionPlacementRecovery>>(
  page: Page,
  record: T,
) {
  const owner = await evaluateControlUiContext(page, ({ gateway }) => ({
    gatewayUrl: gateway.connection.gatewayUrl,
    recoveryScope: gateway.snapshot.client!.recoveryScope,
  }));
  const recovery = { ...owner, ...record };
  const storageKey = sessionPlacementRecoveryExactStorageKey(
    owner.gatewayUrl,
    owner.recoveryScope,
    record.sessionKey,
  );
  await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
    key: storageKey,
    value: recovery,
  });
  return { recovery, storageKey };
}

export async function expectNoRequests(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  ...methods: string[]
) {
  for (const method of methods) {
    expect(await gateway.getRequests(method)).toHaveLength(0);
  }
}
