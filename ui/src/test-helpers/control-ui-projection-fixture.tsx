import { render } from "@solidjs/web";
import { For } from "solid-js";
import { bootstrapApplication, type ApplicationRuntime } from "../app/bootstrap.ts";
import { AgentRowChip } from "../components/agent-row-chip.tsx";
import type { SidebarInboxEntry } from "../components/sidebar-attention-entries.ts";
import { renderSidebarOutboxItem } from "../components/sidebar-outbox-item.tsx";
import { GatewayBoardProvider } from "../lib/board/gateway-provider.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { WidgetPinButton } from "../pages/chat/components/widget-pin-button.tsx";
import type { ControlUiMockGateway } from "./control-ui-e2e-contract.ts";
import { createInstanceResourceFixture } from "./control-ui-instance-resource-fixture.ts";
import type {
  CoreProjectionFamily,
  ProjectionFixtureFacts,
} from "./control-ui-projection-fixture-contract.ts";
import { createProjectionResourceProbe } from "./control-ui-projection-resource-probe.ts";
import { createSdkAvatarFixture } from "./control-ui-sdk-avatar-fixture.ts";

type Group = {
  label: string;
  runtime: ApplicationRuntime;
  root: HTMLElement;
  board?: GatewayBoardProvider;
  boardRevision: number;
  unmount?: () => void;
};
const settle = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
const selector = (family: CoreProjectionFamily) =>
  ({
    "agent-rows": "openclaw-agent-row-chip",
    outbox: '[data-attention-kind="outbox"]',
    "board-pins": "[data-pin-widget]",
  })[family];
function mockGateway(): ControlUiMockGateway {
  const value: unknown = Reflect.get(window, "openclawControlUiE2eGateway");
  if (!value) {
    throw new Error("The projection benchmark requires the existing synthetic Gateway");
  }
  // The existing mock-Gateway installer is the sole writer of this test-only handle.
  return value as ControlUiMockGateway;
}

let active:
  | ReturnType<typeof createFixture>
  | ReturnType<typeof createSdkAvatarFixture>
  | ReturnType<typeof createInstanceResourceFixture>
  | undefined;
function createFixture(family: CoreProjectionFamily, instrumented: boolean) {
  const groups: Group[] = [];
  const probe = instrumented ? createProjectionResourceProbe() : undefined;
  const facts: ProjectionFixtureFacts = { family, instrumented, mounted: [], checkpoints: [] };
  const snapshot = (phase: string) => {
    if (probe) {
      facts.checkpoints.push({ phase, counts: probe.snapshot() });
    }
  };
  const text = (group: Group) =>
    (group.root.textContent ?? "") +
    [...group.root.querySelectorAll("[data-pin-widget]")]
      .map((button) => (button.hasAttribute("data-pinned") ? "1" : "0"))
      .join("");
  const rows = (group: Group) => group.root.querySelectorAll(selector(family)).length;
  const assertRows = (group: Group, count: number) => {
    const actual = rows(group);
    if (actual !== count) {
      throw new Error(`${family}/${group.label}: expected ${count} mounted rows, got ${actual}`);
    }
  };
  async function publish(group: Group, revision: number) {
    if (family === "board-pins") {
      await group.board!.activate();
      group.boardRevision++;
    } else {
      const initial = group.runtime.context.agents.state.agentsList;
      if (!initial) {
        throw new Error(`Missing admitted Agents list: ${group.label}`);
      }
      mockGateway().setMethodResponse("agents.list", {
        ...initial,
        agents: initial.agents.map((agent) =>
          Object.assign({}, agent, { name: `${group.label} publication ${revision}` }),
        ),
      });
      await group.runtime.context.agents.refreshList();
    }
    await settle();
    if (family === "board-pins") {
      const actualRevision = group.board!.snapshot$.value.revision;
      const expectedPinned = group.boardRevision % 2 === 0 ? rows(group) : 0;
      const actualPinned = group.root.querySelectorAll("[data-pin-widget][data-pinned]").length;
      if (actualRevision !== group.boardRevision || actualPinned !== expectedPinned) {
        throw new Error(
          `${group.label}: board publication ${group.boardRevision} did not update its pin buttons`,
        );
      }
    }
  }
  return {
    async setup() {
      // Fresh native runtimes ensure no pre-existing row projection has already connected.
      for (const [label, count] of [
        ["A", 400],
        ["B", 80],
      ] as const) {
        const runtime = bootstrapApplication();
        const root = document.createElement("section");
        root.dataset.projectionApplication = label;
        root.style.cssText =
          "display:grid;gap:2px;grid-template-columns:repeat(8,minmax(0,1fr));font-size:10px";
        const group: Group = { label, runtime, root, boardRevision: 0 };
        groups.push(group);
        document.body.append(root);
        await runtime.start();
        await runtime.context.agents.refreshList();
        if (runtime.context.gateway.snapshot.phase !== "connected") {
          throw new Error(`Fresh projection runtime ${label} did not connect`);
        }
        if (family === "board-pins") {
          const client = runtime.context.gateway.snapshot.client;
          if (!client) {
            throw new Error(`Missing native board client: ${label}`);
          }
          group.board = new GatewayBoardProvider(
            { sessionKey: `agent:main:projection-${label}` },
            client,
          );
          await group.board.activate();
          group.boardRevision = 1;
          const board = group.board;
          probe?.observeWidgets(board.snapshot$.value.widgets, `${label}.widgets`);
          probe?.observeSource(board.snapshot$, `${label}.board.snapshot`, () => {
            probe?.observeWidgets(board.snapshot$.value.widgets, `${label}.widgets`);
          });
        } else {
          for (const name of ["agents", "agentIdentity", "gateway", "sessions"] as const) {
            probe?.observeSource(runtime.context[name], `${label}.${name}`);
          }
        }
        await settle();
        snapshot(`${label}:before-mount`);
        const agentId = runtime.context.agents.state.agentsList?.agents[0]?.id;
        if (!agentId) {
          throw new Error(`Missing synthetic agent for ${label}`);
        }
        const indices = Array.from({ length: count }, (_, index) => index);
        group.unmount = render(
          () => (
            <ApplicationProvider value={runtime.context} host={root}>
              <For each={indices}>
                {(index) => {
                  if (family === "agent-rows") {
                    return <AgentRowChip agentId={agentId} />;
                  }
                  if (family === "board-pins") {
                    return (
                      <WidgetPinButton
                        target={{
                          board: group.board!,
                          name: `projection-widget-${index}`,
                          viewId: `projection-doc-${index}`,
                          mcpApp: false,
                        }}
                      />
                    );
                  }
                  const entry: Extract<SidebarInboxEntry, { type: "outbox" }> = {
                    type: "outbox",
                    category: "system",
                    id: `${label}-outbox-${index}`,
                    sessionKey: "agent:main:interaction-a",
                    agentId,
                    held: true,
                    command: false,
                    severity: "warning",
                    requiresAction: true,
                    dismissal: null,
                  };
                  return renderSidebarOutboxItem(
                    { entry, onNavigate: runtime.context.navigate },
                    runtime.context,
                  );
                }}
              </For>
            </ApplicationProvider>
          ),
          root,
        );
        await settle();
        assertRows(group, count);
        facts.mounted.push({ application: label, expected: count, actual: rows(group) });
        snapshot(`${label}:mounted`);
      }
      if (
        groups[0]!.runtime.context.agents === groups[1]!.runtime.context.agents ||
        groups[0]!.runtime.context.gateway === groups[1]!.runtime.context.gateway
      ) {
        throw new Error("Projection isolation requires independent native owners");
      }
      await publish(groups[0]!, 0);
      await publish(groups[1]!, 0);
      snapshot("warmed");
      return structuredClone(facts);
    },
    async run() {
      const otherText = text(groups[1]!);
      const before = probe?.snapshot();
      for (let revision = 1; revision <= 20; revision++) {
        await publish(groups[0]!, revision);
      }
      if (text(groups[1]!) !== otherText) {
        throw new Error("Publishing A changed B's independent mounted content");
      }
      if (before && probe) {
        const after = probe.snapshot();
        for (const [name, counts] of Object.entries(after.sources)) {
          if (name.startsWith("B.") && counts.callbacks !== before.sources[name]?.callbacks) {
            throw new Error(`Publishing A delivered B callback: ${name}`);
          }
        }
      }
      if (family !== "board-pins" && !text(groups[0]!).includes("A publication 20")) {
        throw new Error("A's final owner publication did not reach its mounted rows");
      }
      assertRows(groups[0]!, 400);
      assertRows(groups[1]!, 80);
      snapshot("published-A");
      return structuredClone(facts);
    },
    async finish() {
      // Retirement checks are outside CPU sampling; B remains independently live.
      groups[0]!.unmount?.();
      groups[0]!.unmount = undefined;
      await settle();
      assertRows(groups[0]!, 0);
      assertRows(groups[1]!, 80);
      snapshot("retired-A");
      await publish(groups[1]!, 21);
      if (family !== "board-pins" && !text(groups[1]!).includes("B publication 21")) {
        throw new Error("B's owner publication did not reach its mounted rows after A retired");
      }
      snapshot("published-B");
      groups[1]!.unmount?.();
      groups[1]!.unmount = undefined;
      await settle();
      assertRows(groups[1]!, 0);
      snapshot("retired-all");
      const remaining = probe?.snapshot();
      if (remaining && Object.values(remaining.sources).some((source) => source.active !== 0)) {
        throw new Error("Fixture subscriptions survived the last mounted consumer");
      }
      return structuredClone(facts);
    },
    dispose() {
      for (const group of groups.toReversed()) {
        group.unmount?.();
        group.board?.dispose();
        group.runtime.stop();
        group.root.remove();
      }
      probe?.dispose();
    },
  };
}

/** This handle exists only in the explicit benchmark entry, never in the shipping graph. */
window.openclawProjectionFixture = {
  async setup(family, instrumented) {
    active?.dispose();
    active =
      family === "sdk-avatars" || family === "sdk-avatar-identities"
        ? createSdkAvatarFixture(family, instrumented)
        : family === "tooltips" ||
            family === "link-providers" ||
            family === "link-metadata" ||
            family === "ci-pairs" ||
            family === "clawhub-cards"
          ? createInstanceResourceFixture(family, instrumented)
          : createFixture(family, instrumented);
    return active.setup();
  },
  run: () => {
    if (!active) {
      throw new Error("Projection fixture is not mounted");
    }
    return active.run();
  },
  finish: () => {
    if (!active) {
      throw new Error("Projection fixture is not mounted");
    }
    return active.finish();
  },
  dispose: () => {
    active?.dispose();
    active = undefined;
  },
};
