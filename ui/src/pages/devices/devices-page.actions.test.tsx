/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { t } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
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

describe("DevicesPage policy saves", () => {
  setupDevicesPageFixtures();

  it.each(["accepted", "rejected"])(
    "retains the policy control and draft while an exec save is %s",
    async (outcome) => {
      const saved = createDeferred();
      const request = vi.fn(async (method: string) => {
        if (method === "exec.approvals.set") {
          await saved.promise;
          return {};
        }
        return responseFor(method);
      });
      const { client } = clientFor(request);
      const page = mountPage(
        gatewayFixture(gatewaySnapshot(client, true, [], ["operator.admin"])),
        {
          nodes: [{ nodeId: "node-1" }],
          execApprovalsSnapshot: {
            path: "/synthetic/exec-approvals.json",
            exists: true,
            hash: "original-base",
            file: { version: 1, defaults: { security: "deny" } },
          },
          execApprovalsForm: { version: 1, defaults: { security: "allowlist" } },
          execApprovalsDirty: true,
        },
      );
      const save = await waitForSolid(() => {
        const control = button(page.container, t("common.save"));
        expect(control.disabled).toBe(false);
        return control;
      });
      save.click();
      await waitForSolid(() => {
        expect(save.textContent).toContain(t("common.saving"));
        expect(save.disabled).toBe(true);
      });
      expect(request).toHaveBeenCalledWith("exec.approvals.set", {
        baseHash: "original-base",
        file: { version: 1, defaults: { security: "allowlist" } },
      });
      if (outcome === "rejected") {
        saved.reject(new Error("Policy changed; reload before saving."));
      } else {
        saved.resolve();
      }
      await waitForSolid(() => expect(save.textContent?.trim()).toBe(t("common.save")));
      expect(button(page.container, t("common.save"))).toBe(save);
      if (outcome === "rejected") {
        expect(page.container.textContent).toContain("Policy changed; reload before saving.");
        expect(save.disabled).toBe(false);
        expect(
          page.container.querySelector<HTMLSelectElement>('select[aria-label="Mode"]')?.value,
        ).toBe("allowlist");
      } else {
        expect(save.disabled).toBe(true);
      }
    },
  );

  it("retires a pending exec save when its Gateway is replaced", async () => {
    const saved = createDeferred();
    const { client } = clientFor(
      vi.fn(async (method: string) => {
        if (method === "exec.approvals.set") {
          await saved.promise;
        }
        return responseFor(method);
      }),
    );
    const page = mountPage(gatewayFixture(gatewaySnapshot(client, true, [], ["operator.admin"])), {
      execApprovalsSnapshot: {
        path: "/synthetic/exec-approvals.json",
        exists: true,
        hash: "original-base",
        file: { version: 1 },
      },
      execApprovalsDirty: true,
    });
    const save = await waitForSolid(() => {
      const control = button(page.container, t("common.save"));
      expect(control.disabled).toBe(false);
      return control;
    });
    save.click();
    await waitForSolid(() => expect(page.container.textContent).toContain(t("common.saving")));
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

  it("shows binding-save progress through the runtime config owner's accepted receipt", async () => {
    const saved = createDeferred();
    const config = { tools: { exec: { node: "original-node" } } };
    const updated = { tools: { exec: { node: "node-1" } } };
    let accepted = false;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: accepted ? updated : config,
          hash: accepted ? "config-saved" : "config-base",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        await saved.promise;
        accepted = true;
        return { config: updated, hash: "config-saved" };
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
    const save = await waitForSolid(() =>
      expectDefined(
        [...page.container.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === t("common.save") && !candidate.disabled,
        ),
        "enabled binding save",
      ),
    );
    save.click();
    await waitForSolid(() => {
      expect(save?.textContent).toContain(t("common.saving"));
      expect(save?.disabled).toBe(true);
    });
    saved.resolve();
    await waitForSolid(() => expect(save?.textContent?.trim()).toBe(t("common.save")));
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("config-saved");
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(save?.disabled).toBe(true);
  });
});
