import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { McpAppSettings } from "../../../src/shared/mcp-app-extensions.js";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { McpAppSettingsForm } from "./solid/mcp-app-settings.tsx";

describe("native app settings", () => {
  it("renders effective grouped values and sends edits only through explicit save", () => {
    const initial: McpAppSettings = {
      schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", title: "Enabled" },
          color: { type: "string", title: "Color", enum: ["red", "blue"] },
          count: { type: "integer", title: "Count", minimum: 1, maximum: 4 },
          name: { type: "string", title: "Name", minLength: 2 },
        },
        required: ["name"],
      },
      values: { enabled: true, color: "blue", count: 2, name: "Parts" },
      layout: [
        {
          kind: "group",
          title: "Display",
          items: [
            { kind: "property", property: "color" },
            { kind: "tool", tool: "reset", title: "Reset defaults" },
          ],
        },
      ],
    };
    const [settings, setSettings] = createSignal(initial);
    const [busy, setBusy] = createSignal(false);
    const onSave = vi.fn();
    const onTool = vi.fn();
    const { container } = mountSolid(() => (
      <McpAppSettingsForm settings={settings()} busy={busy()} onSave={onSave} onTool={onTool} />
    ));
    expect(container.querySelector("legend")?.textContent).toBe("Display");
    expect(container.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked).toBe(true);
    const select = container.querySelector("select")!;
    expect(select.value).toBe("blue");
    expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
    container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onSave).not.toHaveBeenCalled();
    select.value = "red";
    select.dispatchEvent(new Event("change"));
    flush();
    expect(select.value).toBe("red");
    expect(initial.values.color).toBe("blue");
    setBusy(true);
    flush();
    expect(select.value).toBe("red");
    setBusy(false);
    flush();
    expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>("fieldset button")!.click();
    expect(onTool).toHaveBeenCalledWith("reset");
    container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ color: "red" });
    setSettings({ ...initial, values: { ...initial.values, count: 3 } });
    flush();
    expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
    expect(container.querySelector("select")?.value).toBe("blue");
    expect(container.querySelector<HTMLInputElement>("input[type=number]")?.value).toBe("3");
    expect(container.querySelector<HTMLInputElement>("input[type=number]")?.step).toBe("1");
  });
});
