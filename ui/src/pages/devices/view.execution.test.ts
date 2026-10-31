/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSelectElement } from "../../components/agent-select.tsx";
import type {
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
  ExecSecurity,
} from "../../lib/nodes/page-operations.ts";
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

const approvalSection = (container: Element) => getSection(container, "Exec approvals");
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

  it("merges approval scopes and preserves wildcard and selected-agent overrides", async () => {
    const onExecApprovalsSelectAgent = vi.fn();
    const container = renderDevicesContainer({
      configForm: agentsConfig({ main: { name: "Main" }, research: { name: "Research" } }),
      execApprovalsSnapshot: approvalSnapshot(false, {
        "*": { security: "allowlist", ask: "always" },
        main: { ask: "on-miss" },
        retired: { security: "full" },
      }),
      execApprovalsSelectedAgent: "main",
      onExecApprovalsSelectAgent,
    });
    const section = approvalSection(container);
    expect(rowSelect(section, "Security").selectedOptions[0]?.textContent?.trim()).toBe(
      "Use default (allowlist)",
    );
    expect(rowSelect(section, "Ask fallback").selectedOptions[0]?.textContent?.trim()).toBe(
      "Use default (deny)",
    );
    expect(rowSelect(section, "Ask").value).toBe("on-miss");
    expect(getSettingsRow(section, "Security").querySelector(".settings-row__desc")).toBeNull();
    const picker = section.querySelector<AgentSelectElement>("openclaw-agent-select");
    await picker?.updateComplete;
    expect(picker?.options.map((option) => option.value)).toEqual(
      expect.arrayContaining(["__defaults__", "main", "research", "retired"]),
    );
    expect(picker?.options.find((option) => option.value === "main")?.badge).toBe("Default");
    picker?.onSelect("retired");
    expect(onExecApprovalsSelectAgent).toHaveBeenCalledWith("retired");
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

    for (const text of ["Host-native policy", "Read-only here", "hostname", "deny"]) {
      expect(section.textContent).toContain(text);
    }
    expect(section.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });

  it("shows the selected agent's stored policy after the user edited another agent", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const renderScope = (security: ExecSecurity, selected: string) => {
      renderDevicesInto(container, {
        execApprovalsSnapshot: approvalSnapshot(),
        execApprovalsForm: {
          agents: { alpha: { security }, beta: { security: "deny" } },
        },
        execApprovalsSelectedAgent: selected,
      });
      return policySelect(container, "Security");
    };

    // Native selection becomes dirty; switching scope must restore the stored policy.
    let security = renderScope("allowlist", "alpha");
    expect(security.value).toBe("allowlist");
    selectValue(security, "full", true);
    security = renderScope("full", "alpha");
    expect(security.value).toBe("full");
    security = renderScope("full", "beta");
    expect(security.value).toBe("deny");
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
    const section = getSection(container, "Exec node binding");
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
        const section = getSection(container, "Exec node binding");
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
