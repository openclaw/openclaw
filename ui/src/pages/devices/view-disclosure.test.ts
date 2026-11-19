/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevicesViewProps } from "../../test-helpers/devices-fixtures.ts";
import {
  renderDevicesContainer,
  renderDevicesInto,
  getDevicesSection as getSection,
  getDeviceSettingsRow as getSettingsRow,
} from "../../test-helpers/devices-view.tsx";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { DevicesProps } from "./view.types.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

describe("Devices disclosure lifetime", () => {
  it("builds only opened bodies from current inventory and retains them after closing", async () => {
    const node = {
      nodeId: "node-one",
      displayName: "Node One",
      paired: true,
      connected: true,
      commands: ["system.run"],
    };
    const props = createDevicesViewProps({ nodes: [node] });
    const container = renderDevicesContainer(props, false);
    const row = expectDefined(
      container.querySelector<HTMLDetailsElement>('details[data-device-id="node-one"]'),
      "node disclosure",
    );
    expect(row.querySelector(".device-entry__body")).toBeNull();

    const updated = {
      ...props,
      canManagePairing: false,
      nodes: [{ ...node, connected: false }],
    };
    renderDevicesInto(container, updated, false);
    expect(getSettingsRow(container, "Node One")).toBe(row);
    expect(row.querySelector("summary")?.textContent).toContain("Disconnected");
    expect(row.querySelector(".device-entry__body")).toBeNull();

    row.open = true;
    // The native toggle task may follow paint; the open-attribute microtask must suffice.
    await Promise.resolve();
    flush();
    const body = expectDefined(row.querySelector(".device-entry__body"), "opened body");
    const remove = () =>
      expectDefined(
        row.querySelector<HTMLButtonElement>('[data-device-action="remove"]'),
        "remove action",
      );
    expect(remove().disabled).toBe(true);
    const nested = expectDefined(body.querySelector("details"), "nested details");
    nested.open = true;
    row.open = false;
    row.dispatchEvent(new Event("toggle"));
    flush();
    renderDevicesInto(container, { ...updated, canManagePairing: true }, false);
    row.open = true;
    row.dispatchEvent(new Event("toggle"));
    flush();
    expect(row.querySelector(".device-entry__body")).toBe(body);
    expect(nested.open).toBe(true);
    expect(remove().disabled).toBe(false);
  });

  it("opens current policy values and preserves an edited pattern while closed", () => {
    const patches = vi.fn();
    const props: Partial<DevicesProps> = {
      configForm: { agents: { entries: { main: {} } } },
      execApprovalsSnapshot: {
        path: "/synthetic/exec-approvals.json",
        exists: true,
        hash: "base",
        file: {
          version: 1,
          agents: { main: { security: "allowlist", allowlist: [{ pattern: "/usr/bin/git*" }] } },
        },
      },
      onExecApprovalsPatch: patches,
    };
    const container = renderDevicesContainer(props, false);
    const row = getSettingsRow(getSection(container, "Command approvals"), "main");
    if (!(row instanceof HTMLDetailsElement)) {
      throw new Error("Expected a native policy disclosure");
    }
    expect(row.querySelector("textarea")).toBeNull();
    row.open = true;
    row.dispatchEvent(new Event("toggle"));
    flush();
    const input = expectDefined(row.querySelector("textarea"), "pattern field");
    input.value = "/usr/bin/rg*";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(patches).toHaveBeenCalledWith(
      ["agents", "main", "allowlist", 0, "pattern"],
      "/usr/bin/rg*",
    );
    row.open = false;
    row.dispatchEvent(new Event("toggle"));
    flush();
    renderDevicesInto(
      container,
      {
        ...props,
        execApprovalsDirty: true,
        execApprovalsForm: {
          agents: { main: { security: "allowlist", allowlist: [{ pattern: "/usr/bin/rg*" }] } },
        },
      },
      false,
    );
    row.open = true;
    row.dispatchEvent(new Event("toggle"));
    flush();
    expect(row.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("/usr/bin/rg*");
  });
});
