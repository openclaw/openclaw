import { expectDefined } from "@openclaw/normalization-core/expect";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { EnvironmentSummary } from "../../../../packages/gateway-protocol/src/index.js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import * as dom from "./cloud-worker-snapshots-dom.test-support.ts";
import { buildEnvironmentFixture } from "./cloud-worker-snapshots.test-support.ts";

type WorkerDetails = NonNullable<NonNullable<EnvironmentSummary["preparation"]>["details"]>;
export function makeWorker(
  state = "provisioning",
  options: {
    id?: string;
    error?: string;
    status?: EnvironmentSummary["status"];
    details?: Partial<WorkerDetails> | null;
    worker?: Partial<NonNullable<EnvironmentSummary["worker"]>>;
  } = {},
) {
  const base = buildEnvironmentFixture(state, options.error);
  return {
    ...base,
    id: options.id ?? base.id,
    status: options.status ?? base.status,
    preparation: {
      ...base.preparation,
      details:
        options.details === null ? undefined : { ...base.preparation.details, ...options.details },
    },
    worker: { ...base.worker, ...options.worker },
  };
}

export const preparedInventory =
  (environments: ReturnType<typeof makeWorker>[]) =>
  (method: string, params?: Record<string, unknown>) =>
    method === "environments.list" && params?.includePreparedDetails
      ? { environments, profiles: [] }
      : undefined;

export function machineProfile(machineClass = "standard", settings: Record<string, unknown> = {}) {
  return { provider: "crabbox", settings: { provider: "aws", class: machineClass, ...settings } };
}

export function setupSnapshotTests() {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0).toReversed()) {
      dispose();
    }
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await i18n.setLocale("en");
  });
  afterEach(() => vi.useRealTimers());
  return (...args: Parameters<typeof dom.mountPage>) => {
    const fixture = dom.mountPage(...args);
    disposers.push(fixture.dispose);
    return fixture;
  };
}

export const sheet = (page: Element) =>
  expectDefined(page.querySelector(".cloud-environments__sheet"), "Environment sheet");

export function change(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  element.value = value;
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
  flush();
}

export function click(page: Element, label: string) {
  dom.button(page, label).click();
  flush();
}

export const configSnapshot = (config: Record<string, unknown>, hash: string) => ({
  ...sourceConfigSnapshot(config, hash),
  appliedConfigHash: hash,
});

export function configPatch(request: ReturnType<typeof dom.mountPage>["request"]) {
  return waitForSolid(() => {
    const call = request.mock.calls.find(([method]) => method === "config.patch");
    return expectDefined(call, "Config patch request")[1];
  });
}

export const waitText = (element: () => Element, text: string) =>
  waitForSolid(() => expect(element().textContent).toContain(text));

export const waitRequest = (
  request: ReturnType<typeof dom.mountPage>["request"],
  method: string,
  params: Record<string, unknown>,
) => waitForSolid(() => expect(request).toHaveBeenCalledWith(method, params));
