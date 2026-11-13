/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { TemplateWorkspaceFiles } from "./templates-workspace-files.tsx";

describe("Template workspace file roles", () => {
  it("distinguishes canonical roles and gives each help button an accessible purpose", async () => {
    const roles = [
      ["AGENTS.md", /operating instructions/i],
      ["SOUL.md", /persona, tone/i],
      ["USER.md", /preferences/i],
      ["IDENTITY.md", /name, style/i],
      ["BOOTSTRAP.md", /first-run/i],
      ["MEMORY.md", /long-term/i],
      ["TOOLS.md", /retired.*AGENTS.md/i],
      ["HEARTBEAT.md", /retired.*heartbeat monitors/i],
    ] as const;
    const glyphs = new Set<string>();
    for (const [name, purpose] of roles) {
      const onOpen = vi.fn();
      const view = mountSolid(() => (
        <TemplateWorkspaceFiles files={[{ name, source: name }]} onOpen={onOpen} />
      ));
      const help = view.getByRole("button", { name: `About ${name}` });
      await vi.waitFor(() => expect(help.getAttribute("aria-describedby")).toBeTruthy());
      expect(document.getElementById(help.getAttribute("aria-describedby")!)?.textContent).toMatch(
        purpose,
      );
      expect(help.closest("button button")).toBeNull();
      const glyph = view.container.querySelector(".plugin-capability__icon svg")!.innerHTML;
      expect(glyph.length).toBeGreaterThan(0);
      glyphs.add(glyph);
      view.container.querySelector<HTMLButtonElement>(".templates-workspace-file__open")!.click();
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(name);
      view.unmount();
    }
    expect(glyphs.size).toBe(roles.length);
  });

  it("groups supporting files and nested document lookalikes behind View all", () => {
    const onOpen = vi.fn();
    const names = [
      "templates/AGENTS.md",
      "user.md",
      "memory.md",
      "BOOT.md",
      "memory/2026-10-16.md",
      "fixtures/request.json",
    ];
    const view = mountSolid(() => (
      <TemplateWorkspaceFiles
        files={names.map((name) => ({ name, source: name }))}
        onOpen={onOpen}
      />
    ));
    expect(view.queryAllByRole("button")).toHaveLength(1);
    view.getByRole("button", { name: "View all" }).click();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
    expect(view.container.querySelector(".plugin-capability__icon svg")).not.toBeNull();
    expect(view.container.querySelector(".settings-row__chevron svg")).not.toBeNull();
    view.unmount();
  });

  it("omits an empty workspace section", () => {
    const view = mountSolid(() => <TemplateWorkspaceFiles files={[]} onOpen={() => {}} />);
    expect(view.queryByRole("heading")).toBeNull();
  });
});
