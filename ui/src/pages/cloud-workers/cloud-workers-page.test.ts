/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateConfigPatchParams,
  type ConfigPatchParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./cloud-workers-page.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

function actionButton(container: Element, label: string): HTMLButtonElement {
  return expectDefined(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    ),
    `${label} button`,
  );
}

beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const operatingSystems = [
  { id: "linux", label: "Linux", default: true },
  { id: "macos", label: "macOS" },
  { id: "windows/wsl2", label: "Windows (WSL2)" },
];

describe("Cloud Workers mutation requests", () => {
  it.each([
    { action: "delete", initialTarget: undefined, target: undefined, systems: operatingSystems },
    {
      action: "setup-clear",
      initialTarget: undefined,
      target: undefined,
      systems: operatingSystems.slice(0, 1),
    },
    {
      action: "setup-clear",
      initialTarget: "linux",
      target: "linux",
      systems: operatingSystems.slice(0, 1),
    },
    { action: "setup-clear", initialTarget: undefined, target: "macos", systems: operatingSystems },
    {
      action: "setup-clear",
      initialTarget: "linux",
      target: "windows/wsl2",
      systems: operatingSystems,
    },
    {
      action: "setup-clear",
      initialTarget: "windows/wsl2",
      target: "",
      systems: operatingSystems.slice(0, 1),
    },
    { action: "setup-clear", initialTarget: "retired-os", target: "", systems: [] },
  ])(
    "forwards exact array intent for $action and saves OS $initialTarget → $target without losing unrelated data",
    async ({ action, initialTarget, target, systems }) => {
      const settings = {
        provider: "aws",
        class: "standard",
        ttl: "8h",
        idleTimeout: "45m",
        ...(initialTarget ? { target: initialTarget } : {}),
      };
      const retained = { provider: "crabbox", settings: { ...settings, opaque: null } };
      const pending = {
        provider: "crabbox",
        settings: { ...settings, setup: "true", setupEnv: ["QA_WORKER_FLAG"], opaque: null },
      };
      const projectProfiles = {
        "github.com/acme/pending": "pending",
        "github.com/acme/retained": "retained",
      };
      let config: Record<string, unknown> = {
        cloudWorkers: { profiles: { pending, retained }, projectProfiles },
      };
      let hash = "before";
      const patches: ConfigPatchParams[] = [];
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          return {
            config,
            sourceConfig: config,
            raw: JSON.stringify(config),
            hash,
            valid: true,
            issues: [],
          };
        }
        if (method === "environments.list") {
          return { environments: [], profiles: [{ id: "pending", operatingSystems: systems }] };
        }
        if (method !== "config.patch" || !validateConfigPatchParams(params)) {
          throw new Error(`Unexpected request ${method}`);
        }
        patches.push(params);
        const merged = applyMergePatch(config, JSON.parse(params.raw), {
          mergeObjectArraysById: true,
        });
        if (!isRecord(merged)) {
          throw new Error("Expected a merged configuration object");
        }
        config = merged;
        hash = "after";
        return { ok: true, config, hash };
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const gatewayHarness = createGatewayHarness(client);
      gatewayHarness.publish(
        true,
        client,
        gatewayHelloForMethods(["config.patch", "environments.list"]),
      );
      const gateway = Object.assign(gatewayHarness.gateway, {
        connection: { gatewayUrl: "ws://gateway.example.test", token: "", password: "" },
      });
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      const context = {
        gateway,
        runtimeConfig,
        navigate: vi.fn(),
      } as unknown as ApplicationContext;
      const provider = createApplicationContextProvider(context);
      const page = document.createElement("openclaw-cloud-workers-page");
      provider.append(page);
      document.body.append(provider);
      try {
        await waitForFast(() =>
          expect(page.querySelectorAll(".settings-row code")).toHaveLength(2),
        );
        const row = expectDefined(
          [...page.querySelectorAll(".settings-row")].find(
            (entry) => entry.querySelector("code")?.textContent === "pending",
          ),
          "pending profile row",
        );
        if (action === "delete") {
          await waitForFast(() => expect(actionButton(row, "Delete").disabled).toBe(false));
          actionButton(row, "Delete").click();
        } else {
          actionButton(row, "Edit").click();
          await waitForFast(() => expect(page.querySelector("textarea")).not.toBeNull());
          const operatingSystem = page.querySelector<HTMLSelectElement>(
            'select[aria-label="Operating system"]',
          );
          if (
            systems.length < 2 &&
            (!initialTarget || systems.some((system) => system.id === initialTarget))
          ) {
            expect(operatingSystem).toBeNull();
          } else {
            const select = expectDefined(operatingSystem, "Operating system editor");
            expect(select.value).toBe(initialTarget ?? "");
            expect([...select.options].map((option) => option.value)).toEqual([
              "",
              ...systems.map((system) => system.id),
              ...(initialTarget && !systems.some((system) => system.id === initialTarget)
                ? [initialTarget]
                : []),
            ]);
            select.value = expectDefined(target, "Selected OS");
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
          const setup = expectDefined(page.querySelector("textarea"), "Setup editor");
          setup.value = "";
          setup.dispatchEvent(new Event("input", { bubbles: true }));
          await waitForFast(() => expect(actionButton(page, "Save").disabled).toBe(false));
          actionButton(page, "Save").click();
        }
        await waitForFast(() => expect(patches).toHaveLength(1));
        expect(patches[0]).toMatchObject({
          baseHash: "before",
          replacePaths: ["cloudWorkers.profiles.pending.settings.setupEnv"],
        });
        const raw = JSON.parse(expectDefined(patches[0], "mutation request").raw);
        expect(Object.keys(raw.cloudWorkers.profiles)).toEqual(["pending"]);
        const { target: _initialTarget, ...settingsWithoutTarget } = settings;
        expect(config).toEqual({
          cloudWorkers: {
            profiles:
              action === "delete"
                ? { retained }
                : {
                    pending: {
                      provider: "crabbox",
                      install: "bundle",
                      settings: {
                        ...settingsWithoutTarget,
                        ...(target ? { target } : {}),
                        opaque: null,
                      },
                    },
                    retained,
                  },
            projectProfiles:
              action === "delete" ? { "github.com/acme/retained": "retained" } : projectProfiles,
          },
        });
        if (action !== "delete") {
          await waitForFast(() => expect(page.querySelector("textarea")).toBeNull());
          const savedRow = expectDefined(
            [...page.querySelectorAll(".settings-row")].find(
              (entry) => entry.querySelector("code")?.textContent === "pending",
            ),
            "Saved profile row",
          );
          if (target && target !== "linux") {
            expect(savedRow.textContent).toContain(
              `Operating system: ${systems.find((system) => system.id === target)?.label ?? target}`,
            );
          } else {
            expect(savedRow.textContent).not.toContain("Operating system:");
          }
          actionButton(savedRow, "Edit").click();
          await waitForFast(() => expect(page.querySelector("textarea")).not.toBeNull());
          const savedSelect = page.querySelector<HTMLSelectElement>(
            'select[aria-label="Operating system"]',
          );
          if (systems.length >= 2) {
            expect(savedSelect?.value).toBe(target || "");
          } else {
            expect(savedSelect).toBeNull();
          }
          actionButton(page, "Cancel").click();
          actionButton(page, "Add profile").click();
          await waitForFast(() =>
            expect(page.querySelector('input[aria-label="Profile ID"]')).not.toBeNull(),
          );
          expect(page.querySelector('select[aria-label="Operating system"]')).toBeNull();
        }
      } finally {
        provider.remove();
        runtimeConfig.dispose();
      }
    },
  );
});
