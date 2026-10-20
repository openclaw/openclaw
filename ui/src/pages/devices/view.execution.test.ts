/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSelectElement } from "../../components/agent-select.ts";
import type { ExecApprovalsSnapshot, ExecSecurity } from "../../lib/nodes/page-operations.ts";
import {
  renderDevicesContainer,
  renderDevicesInto,
  getDevicesSection as getSection,
  getDeviceSettingsRow as getSettingsRow,
} from "../../test-helpers/devices-view.tsx";
import type { DevicesProps } from "./view.types.ts";

afterEach(() => document.body.replaceChildren());

function approvalSnapshot(exists = true): ExecApprovalsSnapshot {
  return {
    path: "/tmp/exec-approvals.json",
    exists,
    hash: exists ? "sha256:current" : "missing:empty",
    file: { version: 1, agents: {} },
    resolvedDefaults: { security: "full", ask: "off", askFallback: "deny", autoAllowSkills: false },
  };
}

function policySelect(container: Element, title: string) {
  return expectDefined(
    getSettingsRow(getSection(container, "Exec approvals"), title).querySelector("select"),
    `${title} select`,
  );
}

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

describe("devices exec approvals rendering", () => {
  it("renders owner-reported defaults for fresh approval state", () => {
    const container = renderDevicesContainer({ execApprovalsSnapshot: approvalSnapshot(false) });
    const section = getSection(container, "Exec approvals");

    expect(section.textContent).toContain(
      "Allowlist and approval policy for exec host=gateway/node.",
    );
    expect(policySelect(container, "Security").value).toBe("full");
    expect(policySelect(container, "Ask").value).toBe("off");
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
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Node"]')!;
    selectValue(select, "second", true);

    expect(onExecApprovalsTargetChange).toHaveBeenCalledWith("node", "second");
    expect(select.value).toBe("first");
    renderDevicesInto(container, props);
    expect(select.value).toBe("first");

    renderDevicesInto(container, { ...props, execApprovalsTargetNodeId: "second" });
    expect(select.value).toBe("second");
  });

  it("renders defaults, configured agents, and approval-only agents in the avatar picker", async () => {
    const onExecApprovalsSelectAgent = vi.fn();
    const container = renderDevicesContainer({
      configForm: agentsConfig({ main: { name: "Main" }, research: { name: "Research" } }),
      execApprovalsForm: {
        version: 1,
        defaults: { security: "deny" },
        agents: { retired: { security: "full" } },
      },
      execApprovalsSelectedAgent: "research",
      onExecApprovalsSelectAgent,
    });
    const section = getSection(container, "Exec approvals");
    const picker = section.querySelector<AgentSelectElement>("openclaw-agent-select");
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
      nodes: [{ ...approvalNode("windows-node"), displayName: "Windows node" }],
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

    for (const text of ["Host-native policy", "Read-only here", "hostname", "deny"]) {
      expect(section.textContent).toContain(text);
    }
    expect(section.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });

  it("shows the selected agent's stored policy after the user edited another agent", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const renderScope = (security: ExecSecurity, selected: string) => {
      renderDevicesInto(container, {
        execApprovalsSnapshot: approvalSnapshot(),
        execApprovalsForm: {
          version: 1,
          agents: { alpha: { security }, beta: { security: "deny" } },
        },
        execApprovalsSelectedAgent: selected,
      });
      return policySelect(container, "Security");
    };

    // Native selection becomes dirty; switching scope must restore the stored policy.
    let security = renderScope("allowlist", "alpha");
    expect(security.value).toBe("allowlist");
    selectValue(security, "deny", true);
    security = renderScope("deny", "alpha");
    selectValue(security, "full", true);
    security = renderScope("full", "alpha");
    expect(security.value).toBe("full");
    security = renderScope("full", "beta");
    expect(security.value).toBe("deny");
  });
});

describe("devices agent bindings", () => {
  it("reports node bindings and translates each unbound sentinel", () => {
    const onBindDefault = vi.fn();
    const onBindAgent = vi.fn();
    const container = renderDevicesContainer({
      nodes: [{ nodeId: "worker-node", displayName: "Worker node", commands: ["system.run"] }],
      configForm: agentsConfig({ MAIN: {}, research: {} }, "MAIN"),
      onBindDefault,
      onBindAgent,
    });
    const bindingSection = getSection(container, "Exec node binding");
    const selects = bindingSection.querySelectorAll<HTMLSelectElement>("select.settings-select");

    const [defaultBinding, mainBinding] = selects;
    selectValue(defaultBinding!, "worker-node");
    selectValue(defaultBinding!, "");
    selectValue(mainBinding!, "worker-node");
    selectValue(mainBinding!, "__default__");

    expect(onBindDefault.mock.calls).toEqual([["worker-node"], [null]]);
    expect(onBindAgent.mock.calls).toEqual([
      ["MAIN", "worker-node"],
      ["MAIN", null],
    ]);
  });

  it.each([
    {
      name: "ineligible exact IDs ahead of names",
      refs: ["default-node", "agent-node"],
      ineligibleExact: true,
    },
    {
      name: "ambiguous names across the full inventory",
      refs: ["Default worker", "Research worker"],
      competitors: true,
    },
  ])("preserves $name across node loss and recovery", (scenario) => {
    const [defaultRef, agentRef] = scenario.refs;
    const onBindDefault = vi.fn();
    const onBindAgent = vi.fn();
    const configForm = {
      tools: { exec: { node: defaultRef } },
      ...agentsConfig({
        main: {},
        research: { name: "Research", tools: { exec: { node: agentRef } } },
      }),
    };
    const savedConfig = structuredClone(configForm);
    const nodes = [
      { nodeId: "default-node", displayName: "Default worker", remoteIp: "192.0.2.10" },
      { nodeId: "agent-node", displayName: "Research worker", remoteIp: "192.0.2.20" },
    ].map((node) => Object.assign(node, { commands: ["system.run"] }));
    const container = document.createElement("div");
    document.body.append(container);
    const renderBindings = (inventory: DevicesProps["nodes"], unavailable: boolean) => {
      renderDevicesInto(container, { nodes: inventory, configForm, onBindDefault, onBindAgent });
      const section = getSection(container, "Exec node binding");
      ["Default binding", "Research (research)"].forEach((title, index) => {
        const select = expectDefined(
          getSettingsRow(section, title).querySelector<HTMLSelectElement>("select"),
          "node binding",
        );
        const option = expectDefined(select.selectedOptions[0], "selected node binding option");
        const ref = scenario.refs[index];
        const node = expectDefined(nodes[index], "bound node");
        expect({ value: select.value, disabled: option.disabled }).toEqual({
          value: ref,
          disabled: unavailable,
        });
        expect(option.textContent?.replace(/\s+/gu, " ").trim()).toBe(
          unavailable ? `${ref} (Unavailable)` : `${node.displayName} · ${node.nodeId}`,
        );
      });
      expect(configForm).toEqual(savedConfig);
      expect([onBindDefault.mock.calls, onBindAgent.mock.calls]).toEqual([[], []]);
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
    renderBindings(initialNodes, true);
    renderBindings([{ ...expectDefined(nodes[0], "default bound node"), commands: [] }], true);
    renderBindings(nodes, false);
  });
});
