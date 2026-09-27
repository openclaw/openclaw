/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsSnapshot, ExecSecurity } from "../../lib/nodes/page-operations.ts";
import { createDevicesViewProps } from "../../test-helpers/devices-fixtures.ts";
import {
  renderDevicesContainer,
  getDevicesSection as getSection,
  getDeviceSettingsRow as getSettingsRow,
} from "../../test-helpers/devices-view.ts";
import { renderDevices } from "./view.ts";

afterEach(() => document.body.replaceChildren());

describe("devices exec approvals rendering", () => {
  it("renders owner-reported defaults for fresh approval state", () => {
    const container = renderDevicesContainer({
      execApprovalsSnapshot: {
        path: "/tmp/exec-approvals.json",
        exists: false,
        hash: "missing:empty",
        file: { version: 1, agents: {} },
        resolvedDefaults: {
          security: "full",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
      },
    });
    const section = getSection(container, "Exec approvals");

    expect(
      getSettingsRow(section, "Security").querySelector<HTMLSelectElement>("select")?.value,
    ).toBe("full");
    expect(getSettingsRow(section, "Ask").querySelector<HTMLSelectElement>("select")?.value).toBe(
      "off",
    );
  });

  it("preserves authored wildcard and agent overrides above owner defaults", () => {
    const container = renderDevicesContainer({
      execApprovalsSnapshot: {
        path: "/tmp/exec-approvals.json",
        exists: false,
        hash: "missing:empty",
        file: {
          version: 1,
          agents: {
            "*": { security: "allowlist", ask: "always" },
            main: { ask: "on-miss" },
          },
        },
        resolvedDefaults: {
          security: "full",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
      },
      execApprovalsSelectedAgent: "main",
    });
    const section = getSection(container, "Exec approvals");
    const security = getSettingsRow(section, "Security").querySelector<HTMLSelectElement>("select");
    const ask = getSettingsRow(section, "Ask").querySelector<HTMLSelectElement>("select");
    const fallback = getSettingsRow(section, "Ask fallback").querySelector<HTMLSelectElement>(
      "select",
    );

    expect(security?.selectedOptions[0]?.textContent?.trim()).toBe("Use default (allowlist)");
    expect(ask?.value).toBe("on-miss");
    expect(fallback?.selectedOptions[0]?.textContent?.trim()).toBe("Use default (deny)");
    expect(section.textContent).not.toContain("Using default");
    expect(getSettingsRow(section, "Security").querySelector(".settings-row__desc")).toBeNull();
  });

  it("offers only nodes that support both reading and writing approval policy", () => {
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "get-only",
          displayName: "Get only",
          commands: ["system.execApprovals.get"],
        },
        {
          nodeId: "set-only",
          displayName: "Set only",
          commands: ["system.execApprovals.set"],
        },
        {
          nodeId: "editable",
          displayName: "Editable",
          commands: ["system.execApprovals.get", "system.execApprovals.set"],
        },
      ],
      execApprovalsTarget: "node",
    });
    const section = getSection(container, "Exec approvals");
    const nodeSelect = section.querySelector<HTMLSelectElement>('select[aria-label="Node"]');

    expect(Array.from(nodeSelect?.options ?? [], (option) => option.value)).toEqual([
      "",
      "editable",
    ]);
  });

  it("renders defaults, configured agents, and approval-only agents in the avatar picker", async () => {
    const onExecApprovalsSelectAgent = vi.fn();
    const container = renderDevicesContainer({
      configForm: {
        agents: {
          entries: {
            main: { name: "Main", default: true },
            research: { name: "Research" },
          },
        },
      },
      execApprovalsForm: {
        version: 1,
        defaults: { security: "deny" },
        agents: { retired: { security: "full" } },
      },
      execApprovalsSelectedAgent: "research",
      onExecApprovalsSelectAgent,
    });
    const section = getSection(container, "Exec approvals");
    const picker = section.querySelector<
      HTMLElement & {
        options: Array<{ value: string; badge?: string }>;
        onSelect: (value: string) => void;
        updateComplete: Promise<boolean>;
      }
    >("openclaw-agent-select");
    await picker?.updateComplete;

    expect(picker?.options.map((option) => option.value)).toEqual([
      "__defaults__",
      "main",
      "research",
      "retired",
    ]);
    expect(picker?.options.find((option) => option.value === "main")?.badge).toBe("Default");
    picker?.onSelect("retired");
    expect(onExecApprovalsSelectAgent).toHaveBeenCalledWith("retired");
  });

  it("renders host-native Windows policies as read-only", () => {
    const container = renderDevicesContainer({
      nodes: [
        {
          id: "windows-node",
          label: "Windows node",
          commands: ["system.execApprovals.get", "system.execApprovals.set"],
        },
      ],
      execApprovalsTarget: "node",
      execApprovalsTargetNodeId: "windows-node",
      execApprovalsSnapshot: {
        enabled: true,
        hash: "sha256:current",
        defaultAction: "deny",
        rules: [{ pattern: "hostname", action: "allow" }],
      },
    });
    const section = getSection(container, "Exec approvals");

    expect(section.textContent).toContain("Host-native policy");
    expect(section.textContent).toContain("Read-only here");
    expect(section.textContent).toContain("hostname");
    expect(section.textContent).toContain("deny");
    expect(section.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });

  it("shows the selected agent's stored policy after the user edited another agent", () => {
    const snapshot: ExecApprovalsSnapshot = {
      path: "/tmp/exec-approvals.json",
      exists: true,
      hash: "sha256:current",
      file: { version: 1, agents: {} },
      resolvedDefaults: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    };
    const renderScope = (
      container: HTMLElement,
      agents: Record<string, { security: ExecSecurity }>,
      selected: string,
    ) => {
      render(
        renderDevices(
          createDevicesViewProps({
            execApprovalsSnapshot: snapshot,
            execApprovalsForm: { version: 1, agents },
            execApprovalsSelectedAgent: selected,
          }),
        ),
        container,
      );
      return expectDefined(
        getSettingsRow(
          getSection(container, "Exec approvals"),
          "Security",
        ).querySelector<HTMLSelectElement>("select"),
        "security select",
      );
    };
    const pick = (select: HTMLSelectElement, value: string) => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const container = document.createElement("div");
    document.body.append(container);

    // Picking an option marks it dirty, so the browser ignores later `selected`
    // attribute changes. `?selected` still seeds the first paint (Lit sets
    // select.value before its options exist); `live()` re-writes the value on
    // later renders so scope switches show the stored policy.
    let security = renderScope(
      container,
      { alpha: { security: "allowlist" }, beta: { security: "deny" } },
      "alpha",
    );
    expect(security.value).toBe("allowlist");
    pick(security, "deny");
    security = renderScope(
      container,
      { alpha: { security: "deny" }, beta: { security: "deny" } },
      "alpha",
    );
    pick(security, "full");
    security = renderScope(
      container,
      { alpha: { security: "full" }, beta: { security: "deny" } },
      "alpha",
    );
    expect(security.value).toBe("full");

    security = renderScope(
      container,
      { alpha: { security: "full" }, beta: { security: "deny" } },
      "beta",
    );
    expect(security.value).toBe("deny");
  });
});

describe("devices agent bindings", () => {
  it("reports node bindings and translates each unbound sentinel", () => {
    const onBindDefault = vi.fn();
    const onBindAgent = vi.fn();
    const container = renderDevicesContainer({
      nodes: [
        {
          nodeId: "worker-node",
          displayName: "Worker node",
          commands: ["system.run"],
        },
      ],
      configForm: {
        agents: {
          entries: {
            MAIN: { default: true },
            research: {},
          },
        },
      },
      onBindDefault,
      onBindAgent,
    });
    const bindingSection = getSection(container, "Exec node binding");
    const selects = bindingSection.querySelectorAll<HTMLSelectElement>("select.settings-select");

    const [defaultBinding, mainBinding] = selects;
    defaultBinding!.value = "worker-node";
    defaultBinding!.dispatchEvent(new Event("change"));
    defaultBinding!.value = "";
    defaultBinding!.dispatchEvent(new Event("change"));
    mainBinding!.value = "worker-node";
    mainBinding!.dispatchEvent(new Event("change"));
    mainBinding!.value = "__default__";
    mainBinding!.dispatchEvent(new Event("change"));

    expect(onBindDefault.mock.calls).toEqual([["worker-node"], [null]]);
    expect(onBindAgent.mock.calls).toEqual([
      ["MAIN", "worker-node"],
      ["MAIN", null],
    ]);
  });

  it.each([
    { name: "IDs", refs: ["default-node", "agent-node"] },
    {
      name: "ineligible exact IDs ahead of names",
      refs: ["default-node", "agent-node"],
      ineligibleExact: true,
      unavailable: true,
    },
    { name: "normalized names", refs: ["default_worker", "RESEARCH-WORKER"] },
    { name: "addresses", refs: ["192.0.2.10", "192.0.2.20"] },
    { name: "ID prefixes", refs: ["default", "agent-"] },
    {
      name: "ambiguous names across the full inventory",
      refs: ["Default worker", "Research worker"],
      competitors: true,
      unavailable: true,
    },
  ])("preserves $name across node loss and recovery", (scenario) => {
    const [defaultRef, agentRef] = scenario.refs;
    const onBindDefault = vi.fn();
    const onBindAgent = vi.fn();
    const configForm = {
      tools: { exec: { node: defaultRef } },
      agents: {
        entries: {
          main: { default: true },
          research: { name: "Research", tools: { exec: { node: agentRef } } },
        },
      },
    };
    const savedConfig = structuredClone(configForm);
    const nodes = [
      { nodeId: "default-node", displayName: "Default worker", remoteIp: "192.0.2.10" },
      { nodeId: "agent-node", displayName: "Research worker", remoteIp: "192.0.2.20" },
    ].map((node) =>
      Object.assign(node, {
        commands: ["system.run"],
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const renderBindings = (inventory: Array<Record<string, unknown>>, unavailable: boolean) => {
      render(
        renderDevices(
          createDevicesViewProps({ nodes: inventory, configForm, onBindDefault, onBindAgent }),
        ),
        container,
      );
      const section = getSection(container, "Exec node binding");
      ["Default binding", "Research (research)"].forEach((title, index) => {
        const select = expectDefined(
          getSettingsRow(section, title).querySelector<HTMLSelectElement>("select"),
          "node binding",
        );
        const option = expectDefined(select.selectedOptions[0], "selected node binding option");
        const ref = scenario.refs[index];
        const node = expectDefined(nodes[index], "bound node");
        expect(select.value).toBe(ref);
        expect(option.disabled).toBe(unavailable);
        expect(option.textContent?.replace(/\s+/gu, " ").trim()).toBe(
          unavailable ? `${ref} (Unavailable)` : `${node.displayName} · ${node.nodeId}`,
        );
      });
      expect(configForm).toEqual(savedConfig);
      expect(onBindDefault).not.toHaveBeenCalled();
      expect(onBindAgent).not.toHaveBeenCalled();
    };
    const competitors = scenario.competitors
      ? nodes.map((node) => ({
          ...node,
          nodeId: `${node.nodeId}-competitor`,
          commands: [],
          connected: false,
        }))
      : [];
    const initialNodes = scenario.ineligibleExact
      ? [
          ...nodes.map((node) => ({ ...node, commands: [] })),
          ...nodes.map((node) => ({
            ...node,
            nodeId: `${node.nodeId}-other`,
            displayName: node.nodeId,
          })),
        ]
      : [...nodes, ...competitors];
    renderBindings(initialNodes, scenario.unavailable ?? false);
    renderBindings([{ ...nodes[0], commands: [] }], true);
    renderBindings(nodes, false);
  });
});
