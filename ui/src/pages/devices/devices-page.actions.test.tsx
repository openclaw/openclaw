/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ConfigSnapshot } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { openDeviceDisclosures } from "../../test-helpers/devices-view.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  gatewaySnapshot,
  gatewayFixture,
  mountPage,
  responseFor,
  clientFor,
  button,
  cleanups,
  setupDevicesPageFixtures,
} from "./devices-page.test-support.tsx";

const policyFile = { version: 1 as const, defaults: { security: "allowlist" as const } };

function mountPolicySave() {
  const saved = createDeferred();
  const request = vi.fn(async (method: string) =>
    method === "exec.approvals.set" ? saved.promise.then(() => ({})) : responseFor(method),
  );
  const { client } = clientFor(request);
  const page = mountPage(gatewayFixture(gatewaySnapshot(client, true, [], ["operator.admin"])), {
    nodes: [{ nodeId: "node-1" }],
    execApprovalsSnapshot: {
      path: "/synthetic/exec-approvals.json",
      exists: true,
      hash: "original-base",
      file: { version: 1, defaults: { security: "deny" } },
    },
    execApprovalsForm: policyFile,
    execApprovalsDirty: true,
  });
  return { saved, request, page };
}

async function startSave(container: ParentNode) {
  const save = await waitForSolid(() =>
    expectDefined(
      [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === t("common.save") && !candidate.disabled,
      ),
      "enabled save",
    ),
  );
  openDeviceDisclosures(container);
  save.click();
  await waitForSolid(() => {
    expect(save.textContent).toContain(t("common.saving"));
    expect(save.disabled).toBe(true);
  });
  return save;
}

describe("DevicesPage policy saves", () => {
  setupDevicesPageFixtures();

  it("refreshes known configuration without holding inventory on the fresh read", async () => {
    const refresh = createDeferred<unknown>();
    let configReads = 0;
    const { client } = clientFor(
      vi.fn(async (method: string) =>
        method === "config.get" && ++configReads > 1 ? refresh.promise : responseFor(method),
      ),
    );
    const fixture = gatewayFixture(gatewaySnapshot(client, true, [], ["operator.admin"]));
    const runtimeConfig = createRuntimeConfigCapability(fixture.source);
    cleanups.push(() => runtimeConfig.dispose());
    await runtimeConfig.ensureLoaded();
    const page = mountPage(
      fixture,
      { nodes: [{ nodeId: "available", displayName: "Available node" }] },
      undefined,
      runtimeConfig,
    );
    await waitForSolid(() => expect(configReads).toBe(2));
    expect(page.container.textContent).toContain("Available node");
    refresh.resolve(responseFor("config.get"));
  });

  it.each(["accepted", "rejected"])(
    "retains the policy control and draft while an exec save is %s",
    async (outcome) => {
      const { saved, request, page } = mountPolicySave();
      const save = await startSave(page.container);
      expect(request).toHaveBeenCalledWith("exec.approvals.set", {
        baseHash: "original-base",
        file: policyFile,
      });
      if (outcome === "rejected") {
        saved.reject(new Error("Policy changed; reload before saving."));
      } else {
        saved.resolve();
      }
      await waitForSolid(() => expect(save.textContent?.trim()).toBe(t("common.save")));
      expect(button(page.container, t("common.save"))).toBe(save);
      expect(save.disabled).toBe(outcome === "accepted");
      if (outcome === "rejected") {
        expect(page.container.textContent).toContain("Policy changed; reload before saving.");
        const mode = page.container.querySelector<HTMLSelectElement>(
          'select[aria-label="Security"]',
        );
        expect(mode?.value).toBe("allowlist");
      }
    },
  );

  it("retires a pending exec save when its Gateway is replaced", async () => {
    const { saved, page } = mountPolicySave();
    await startSave(page.container);
    const replacement = clientFor();
    page.replaceGateway(
      gatewayFixture(gatewaySnapshot(replacement.client, true, [], ["operator.admin"])),
    );
    await waitForSolid(() => expect(page.container.textContent).not.toContain(t("common.saving")));
    saved.reject(new Error("Retired policy write failed."));
    await waitForSolid(() =>
      expect(page.container.textContent).not.toContain("Retired policy write failed."),
    );
    expect(replacement.request.mock.calls.map(([method]) => method)).not.toContain(
      "exec.approvals.set",
    );
  });

  it("saves a binding on its own, with no Save beside it", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { config: { tools: { exec: {} } }, hash: "config-base", valid: true, issues: [] };
      }
      if (method === "config.set") {
        return { config: { tools: { exec: { node: "node-1" } } }, hash: "config-saved" };
      }
      return responseFor(method);
    });
    const { client } = clientFor(request);
    const fixture = gatewayFixture(
      gatewaySnapshot(client, true, ["config.set"], ["operator.admin"]),
    );
    const runtimeConfig = createRuntimeConfigCapability(fixture.source);
    cleanups.push(() => runtimeConfig.dispose());
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["tools", "exec", "node"], "node-1");
    const page = mountPage(fixture, { nodes: [{ nodeId: "node-1" }] }, undefined, runtimeConfig);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(
      [...page.container.querySelectorAll("button")].filter(
        (candidate) => candidate.textContent?.trim() === t("common.save") && !candidate.disabled,
      ),
    ).toHaveLength(0);
    await waitForSolid(
      () => expect(runtimeConfig.state.configSnapshot?.hash).toBe("config-saved"),
      {
        timeout: 3_000,
      },
    );
    expect(runtimeConfig.state.configFormDirty).toBe(false);
  });

  it("clears a saved binding after connecting during a shared display read", async () => {
    const displayRead = createDeferred<ConfigSnapshot>();
    const original = { tools: { exec: { node: "saved-node" } } };
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return displayRead.promise;
      }
      if (method === "config.set") {
        return { config: { tools: { exec: {} } }, hash: "saved" };
      }
      return responseFor(method);
    });
    const { client } = clientFor(request);
    const fixture = gatewayFixture(gatewaySnapshot(null, false));
    const runtimeConfig = createRuntimeConfigCapability(fixture.source);
    cleanups.push(() => runtimeConfig.dispose());
    const page = mountPage(fixture, {}, undefined, runtimeConfig);
    await waitForSolid(() => expect(page.container.textContent).toContain("Devices"));

    fixture.emitSnapshot(gatewaySnapshot(client, true, ["config.set"], ["operator.admin"]));
    expect(runtimeConfig.state.configLoading).toBe(true);
    displayRead.resolve({
      config: original,
      raw: JSON.stringify(original),
      hash: "original",
      valid: true,
      issues: [],
    });
    const binding = await waitForSolid(() => {
      const select = expectDefined(
        page.container.querySelector<HTMLSelectElement>('select[aria-label="Device"]'),
        "saved binding",
      );
      expect(select.value).toBe("saved-node");
      expect(select.disabled).toBe(false);
      return select;
    });
    binding.value = "";
    binding.dispatchEvent(new Event("change", { bubbles: true }));
    await runtimeConfig.flushFormChanges();
    expect(request).toHaveBeenCalledWith("config.set", {
      raw: `${JSON.stringify({ tools: { exec: {} } }, null, 2)}\n`,
      baseHash: "original",
    });
  });
});
