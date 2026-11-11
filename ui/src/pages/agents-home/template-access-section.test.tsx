/* @vitest-environment jsdom */

import { getQueriesForElement as within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { TemplateAccessSection } from "./template-access-section.tsx";
import type { TemplateCatalogDetail } from "./templates-catalog-client.ts";

describe("Template execution settings", () => {
  it.each<TemplateCatalogDetail["access"]>([
    undefined,
    {},
    { sandbox: {} },
    { tools: {} },
    { tools: { fs: {} } },
  ])("omits the whole section when no setting is declared: %j", (access) => {
    const view = mountSolid(() => <TemplateAccessSection access={access} />);
    expect(view.queryByRole("heading", { name: "Execution settings" })).toBeNull();
    expect(view.container.childElementCount).toBe(0);
    view.unmount();
  });

  it.each<NonNullable<TemplateCatalogDetail["access"]>>([
    { sandbox: { mode: "off" } },
    { sandbox: { scope: "agent" } },
    { sandbox: { workspaceAccess: "none" } },
    { tools: { profile: "minimal" } },
    { tools: { allow: [] } },
    { tools: { alsoAllow: [] } },
    { tools: { deny: [] } },
    { tools: { fs: { workspaceOnly: false } } },
  ])("keeps a partial or explicitly disabled declaration visible: %j", (access) => {
    const view = mountSolid(() => <TemplateAccessSection access={access} />);
    expect(view.getByRole("heading", { name: "Execution settings" })).toBeTruthy();
    const details = view.getByLabelText("Declared access settings");
    expect(details.hasAttribute("open")).toBe(false);
    view.getByText("View access details").click();
    expect(details.hasAttribute("open")).toBe(true);
    expect(view.getByText(/Host policy determines effective access/)).toBeTruthy();
    view.unmount();
  });

  it("updates visibility when the selected Template's declarations change", () => {
    let update!: (access: TemplateCatalogDetail["access"]) => void;
    const view = mountSolid(() => {
      const [access, setAccess] = createSignal<TemplateCatalogDetail["access"]>();
      update = setAccess;
      return <TemplateAccessSection access={access()} />;
    });
    expect(view.container.childElementCount).toBe(0);
    update({ tools: { fs: { workspaceOnly: false } } });
    flush();
    expect(view.getByRole("heading", { name: "Execution settings" })).toBeTruthy();
    update({ tools: { fs: {} } });
    flush();
    expect(view.container.childElementCount).toBe(0);
    view.unmount();
  });

  it("keeps exact declarations alphabetical behind disclosure without mutating policy", () => {
    const allow = ["web_fetch", "read"];
    const deny = ["write", "exec"];
    const view = mountSolid(() => (
      <TemplateAccessSection
        access={{
          sandbox: { mode: "off", scope: "agent", workspaceAccess: "ro" },
          tools: { profile: "full", allow, deny, fs: { workspaceOnly: false } },
        }}
      />
    ));
    const details = view.getByLabelText("Declared access settings");
    expect(details.hasAttribute("open")).toBe(false);
    view.getByText("View access details").click();
    const fields = within(details);
    for (const value of [
      "Off",
      "Per agent",
      "Read-only",
      "full",
      "read, web_fetch",
      "exec, write",
      "Workspace-only restriction off",
    ]) {
      expect(fields.getByText(value, { exact: true })).toBeTruthy();
    }
    expect(
      Array.from(details.querySelectorAll(".settings-row__title"), (row) => row.textContent),
    ).toEqual([
      "Denied tools",
      "Explicit tool allowlist",
      "Filesystem restriction",
      "Sandbox",
      "Sandbox scope",
      "Sandbox workspace access",
      "Tool profile",
    ]);
    expect(allow).toEqual(["web_fetch", "read"]);
    expect(deny).toEqual(["write", "exec"]);
    view.unmount();
  });

  it("highlights isolation, separate file restrictions and declared rule counts", () => {
    const view = mountSolid(() => (
      <TemplateAccessSection
        access={{
          sandbox: { mode: "all", workspaceAccess: "ro" },
          tools: {
            profile: "minimal",
            alsoAllow: ["web_search", "group:fs"],
            deny: ["exec"],
            fs: { workspaceOnly: true },
          },
        }}
      />
    ));
    const summary = within(view.getByLabelText("Execution summary"));
    for (const value of [
      "All sessions",
      "Workspace-confined tools",
      "Sandbox workspace: Read-only",
      "minimal",
      "Additions: 2 · Deny entries: 1",
    ]) {
      expect(summary.getByText(value, { exact: true })).toBeTruthy();
    }
    expect(view.getByLabelText("Declared access settings").hasAttribute("open")).toBe(false);
    view.unmount();
  });
});
