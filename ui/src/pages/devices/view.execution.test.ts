/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "../../lib/nodes/page-operations.ts";
import {
  renderDevicesContainer,
  renderDevicesInto,
  getDevicesSection as getSection,
  getDeviceSettingsRow as getSettingsRow,
} from "../../test-helpers/devices-view.tsx";
import type { DevicesProps } from "./view.types.ts";

afterEach(() => document.body.replaceChildren());

function approvalSnapshot(
  exists = true,
  agents: ExecApprovalsFile["agents"] = {},
): ExecApprovalsSnapshot {
  return {
    path: "/tmp/exec-approvals.json",
    exists,
    hash: exists ? "sha256:current" : "missing:empty",
    file: { version: 1, agents },
    resolvedDefaults: { security: "full", ask: "off", askFallback: "deny", autoAllowSkills: false },
  };
}

function rowSelect(section: Element, title: string) {
  return expectDefined(getSettingsRow(section, title).querySelector("select"), `${title} select`);
}

const approvalSection = (container: Element) => getSection(container, "Command approvals");
const scopeRow = (section: Element, name: string) =>
  expectDefined(
    Array.from(section.querySelectorAll(".device-entry")).find(
      (row) => row.querySelector("summary .settings-row__title")?.textContent === name,
    ),
    `${name} policy`,
  );
const summaryParts = (row: Element) =>
  Array.from(row.querySelectorAll("summary .device-entry__part"), (part) => part.textContent);
const policySelect = (container: Element, title: string) =>
  rowSelect(approvalSection(container), title);

function selectValue(select: HTMLSelectElement, value: string, bubbles = false) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles }));
}

const approvalNode = (nodeId: string) => ({
  nodeId,
  commands: ["system.execApprovals.get", "system.execApprovals.set"],
});
const agentsConfig = (entries: Record<string, unknown>, agentId = "main") => ({
  agents: { defaults: { systemAgent: { agentId } }, entries },
});

describe("devices execution settings", () => {
  it("renders owner-reported defaults for fresh approval state", () => {
    const container = renderDevicesContainer({ execApprovalsSnapshot: approvalSnapshot(false) });
    expect(policySelect(container, "Security").value).toBe("full");
    expect(policySelect(container, "Ask").value).toBe("off");
  });

  it("lists every scope with what it changes and preserves wildcard and agent overrides", () => {
    const container = renderDevicesContainer({
      configForm: agentsConfig({ main: { name: "Main" }, research: { name: "Research" } }),
      execApprovalsSnapshot: approvalSnapshot(false, {
        "*": { security: "allowlist", ask: "always" },
        main: { ask: "on-miss" },
        retired: { security: "full" },
      }),
    });
    const section = approvalSection(container);
    const scopes = Array.from(
      section.querySelectorAll(".device-entry"),
      (row) => row.querySelector("summary .settings-row__title")?.textContent,
    );
    expect(scopes).toEqual(["Defaults", "Main", "*", "Research", "retired"]);
    const main = scopeRow(section, "Main");
    expect(rowSelect(main, "Security").selectedOptions[0]?.textContent?.trim()).toBe(
      "Use default (Allowlist)",
    );
    expect(rowSelect(main, "Ask fallback").selectedOptions[0]?.textContent?.trim()).toBe(
      "Use default (Deny)",
    );
    expect(rowSelect(main, "Ask").value).toBe("on-miss");
    expect(getSettingsRow(main, "Security").querySelector(".settings-row__desc")).toBeNull();
    expect(getSettingsRow(main, "Ask").querySelector(".settings-row__desc")).toBeNull();
    expect(summaryParts(scopeRow(section, "Defaults"))).toEqual(["Security: Full", "Ask: Off"]);
    expect(summaryParts(main)).toEqual(["Default agent", "Ask: On miss"]);
    expect(summaryParts(scopeRow(section, "Research"))).toEqual(["Uses defaults"]);
    expect(summaryParts(scopeRow(section, "retired"))).toEqual(["Security: Full"]);
  });

  it("shows an id only when it differs from the name, in both sections", () => {
    const container = renderDevicesContainer({
      nodes: [{ nodeId: "worker-node", commands: ["system.run"] }],
      configForm: agentsConfig({ OPS: { name: "ops" }, triage: { name: "Night triage" } }, "OPS"),
      execApprovalsSnapshot: approvalSnapshot(),
    });
    for (const title of ["ops", "Night triage (triage)"]) {
      expect(getSettingsRow(approvalSection(container), title)).toBeInstanceOf(Element);
      expect(getSettingsRow(getSection(container, "Device binding"), title)).toBeInstanceOf(
        Element,
      );
    }
  });

  it.each([
    ["deny", true],
    ["allowlist", false],
    ["full", false],
  ] as const)("dims an allowlist under %s only when Deny stops every command", (security, dim) => {
    const container = renderDevicesContainer({
      configForm: agentsConfig({ main: {} }),
      execApprovalsSnapshot: approvalSnapshot(true, {
        main: { security, allowlist: [{ pattern: "/usr/bin/git*" }] },
      }),
    });
    const list = scopeRow(approvalSection(container), "main").querySelector(".device-allowlist");
    expect(list?.classList.contains("device-allowlist--inactive")).toBe(dim);
  });

  it("offers Save only for a draft and reports a rejected save beside it", () => {
    const onSaveExecApprovals = vi.fn();
    const props = { execApprovalsSnapshot: approvalSnapshot(), onSaveExecApprovals };
    const clean = renderDevicesContainer(props);
    expect(approvalSection(clean).querySelector(".device-policy__save")).toBeNull();

    const draft = renderDevicesContainer({
      ...props,
      execApprovalsDirty: true,
      execApprovalsError: "Policy changed; reload before saving.",
    });
    const row = expectDefined(
      approvalSection(draft).querySelector(".device-policy__save"),
      "save row",
    );
    expect(row.textContent).toContain("You have unsaved changes");
    expect(row.querySelector('[role="alert"]')?.textContent).toContain("Policy changed");
    row.querySelector("button")?.click();
    expect(onSaveExecApprovals).toHaveBeenCalledOnce();
  });

  it("shows a failed load in place with a retry", () => {
    const onLoadExecApprovals = vi.fn();
    const container = renderDevicesContainer({
      execApprovalsError: "Gateway unavailable",
      onLoadExecApprovals,
    });
    const section = approvalSection(container);
    expect(section.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load approvals. Try again.",
    );
    expect(section.textContent).toContain("Gateway unavailable");
    expect(container.querySelector(".callout.danger")).toBeNull();
    Array.from(section.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry")
      ?.click();
    expect(onLoadExecApprovals).toHaveBeenCalledOnce();
  });

  it("edits an allowlist where the patterns read", () => {
    const onExecApprovalsPatch = vi.fn();
    const onExecApprovalsRemove = vi.fn();
    const container = renderDevicesContainer({
      configForm: agentsConfig({ main: {} }),
      execApprovalsSnapshot: approvalSnapshot(true, {
        main: {
          allowlist: [
            { pattern: "/usr/bin/git*", lastUsedAt: Date.now(), lastUsedCommand: "git status" },
            { pattern: "/opt/tool" },
          ],
        },
      }),
      onExecApprovalsPatch,
      onExecApprovalsRemove,
    });
    const main = scopeRow(approvalSection(container), "main");
    expect(summaryParts(main)).toEqual(["Default agent", "2 patterns"]);
    const inputs = main.querySelectorAll<HTMLTextAreaElement>(".device-allowlist__input");
    expect(Array.from(inputs, (input) => input.value)).toEqual(["/usr/bin/git*", "/opt/tool"]);
    expect(main.querySelector(".device-allowlist")?.textContent).not.toContain("/usr/bin/git*");
    expect(main.querySelector(".device-allowlist")?.textContent).toContain("git status");
    inputs[1]!.value = "/opt/tools/*";
    inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onExecApprovalsPatch).toHaveBeenCalledWith(
      ["agents", "main", "allowlist", 1, "pattern"],
      "/opt/tools/*",
    );
    main.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove"]')[0]?.click();
    expect(onExecApprovalsRemove).toHaveBeenCalledWith(["agents", "main", "allowlist", 0]);
  });

  it("keeps the selected node until its owner accepts a target change", () => {
    const onExecApprovalsTargetChange = vi.fn();
    const props = {
      nodes: ["first", "second"].map(approvalNode),
      execApprovalsTarget: "node" as const,
      execApprovalsTargetNodeId: "first",
      execApprovalsDirty: true,
      onExecApprovalsTargetChange,
    };
    const container = renderDevicesContainer(props);
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Device"]')!;
    selectValue(select, "second", true);

    expect(onExecApprovalsTargetChange).toHaveBeenCalledWith("node", "second");
    expect(select.value).toBe("first");
    renderDevicesInto(container, props);
    expect(select.value).toBe("first");

    renderDevicesInto(container, { ...props, execApprovalsTargetNodeId: "second" });
    expect(select.value).toBe("second");
  });

  it("renders host-native Windows policies as read-only", () => {
    const container = renderDevicesContainer({
      nodes: [{ ...approvalNode("windows-node"), displayName: "Windows node" }],
      execApprovalsTarget: "node",
      execApprovalsTargetNodeId: "windows-node",
      execApprovalsDirty: true,
      execApprovalsSnapshot: {
        enabled: true,
        hash: "sha256:current",
        defaultAction: "deny",
        rules: [{ pattern: "hostname", action: "allow" }],
      },
    });
    const section = approvalSection(container);

    for (const text of ["Device-managed policy", "Read-only here", "hostname", "deny"]) {
      expect(section.textContent).toContain(text);
    }
    expect(section.querySelector("button")).toBeNull();
  });

  it("keeps each agent on its stored policy after another agent is edited", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const render = (security: "allowlist" | "full") => {
      renderDevicesInto(container, {
        execApprovalsSnapshot: approvalSnapshot(),
        execApprovalsForm: {
          agents: { alpha: { security }, beta: { security: "deny" } },
        },
      });
      const section = approvalSection(container);
      return [scopeRow(section, "alpha"), scopeRow(section, "beta")].map(
        (row) => rowSelect(row, "Security").value,
      );
    };
    expect(render("allowlist")).toEqual(["allowlist", "deny"]);
    expect(render("full")).toEqual(["full", "deny"]);
  });

  it("collapses bindings to one line when no node can run them", () => {
    const container = renderDevicesContainer({
      nodes: [],
      configForm: agentsConfig({ main: {}, research: {} }),
    });
    const section = getSection(container, "Device binding");
    expect(section.querySelector("select")).toBeNull();
    expect(section.textContent).toContain("No devices can run commands yet.");
  });

  it("offers no Save for bindings and names what an agent inherits", () => {
    const container = renderDevicesContainer({
      nodes: [{ nodeId: "worker-node", displayName: "Worker", commands: ["system.run"] }],
      configForm: { ...agentsConfig({ main: {} }), tools: { exec: { node: "worker-node" } } },
    });
    const section = getSection(container, "Device binding");
    expect(section.querySelector("button")).toBeNull();
    expect(rowSelect(section, "main").selectedOptions[0]?.textContent?.trim()).toBe(
      "Use default (worker-node)",
    );
  });

  it("reports node bindings and translates each unbound sentinel", () => {
    const onBindDefault = vi.fn();
    const onBindAgent = vi.fn();
    const container = renderDevicesContainer({
      nodes: [{ nodeId: "worker-node", displayName: "Worker node", commands: ["system.run"] }],
      configForm: agentsConfig({ MAIN: {}, research: {} }, "MAIN"),
      onBindDefault,
      onBindAgent,
    });
    const section = getSection(container, "Device binding");
    const bind = (title: string, sentinel: string) => {
      const select = rowSelect(section, title);
      selectValue(select, "worker-node");
      selectValue(select, sentinel);
    };
    bind("Default binding", "");
    bind("MAIN", "__default__");
    expect(onBindDefault.mock.calls).toEqual([["worker-node"], [null]]);
    expect(onBindAgent.mock.calls).toEqual([
      ["MAIN", "worker-node"],
      ["MAIN", null],
    ]);
  });

  it.each(["worker-node", "Worker"])(
    "preserves binding %s across node loss and recovery",
    (ref) => {
      const node = { nodeId: "worker-node", displayName: "Worker", commands: ["system.run"] };
      const ineligibleExact = ref === node.nodeId;
      const onBindDefault = vi.fn();
      const onBindAgent = vi.fn();
      const configForm = {
        tools: { exec: { node: ref } },
        ...agentsConfig({ research: { tools: { exec: { node: ref } } } }),
      };
      const savedConfig = structuredClone(configForm);
      const container = document.body.appendChild(document.createElement("div"));
      const renderBindings = (inventory: DevicesProps["nodes"], unavailable: boolean) => {
        renderDevicesInto(container, { nodes: inventory, configForm, onBindDefault, onBindAgent });
        const section = getSection(container, "Device binding");
        for (const title of ["Default binding", "research"]) {
          const select = rowSelect(section, title);
          expect(select).toHaveProperty("value", ref);
          expect(select.selectedOptions[0]).toMatchObject({
            value: ref,
            disabled: unavailable,
            textContent: unavailable ? `${ref} (Unavailable)` : "Worker · worker-node",
          });
        }
        expect(configForm).toEqual(savedConfig);
        expect([onBindDefault.mock.calls, onBindAgent.mock.calls]).toEqual([[], []]);
      };
      renderBindings(
        [
          { ...node, commands: ineligibleExact ? [] : node.commands },
          {
            ...node,
            nodeId: "other",
            displayName: ref,
            commands: ineligibleExact ? node.commands : [],
            connected: false,
          },
        ],
        true,
      );
      renderBindings([{ ...node, commands: [] }], true);
      renderBindings([node], false);
    },
  );
});
